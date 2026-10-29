# Dot-source only: all mutations require explicit calls by the transaction.
function Write-RecoveryJournal($Backup, $Phase, $Details = @{}) {
    $entry = @{version=1; phase=$Phase; at=[DateTime]::UtcNow.ToString('o'); details=$Details}
    # Append, flush and close: a torn last record does not overwrite prior evidence.
    $line = ($entry | ConvertTo-Json -Compress -Depth 6) + "`r`n"
    $stream = [IO.File]::Open((Join-Path $Backup 'journal.jsonl'),'Append','Write','Read')
    try {$bytes=[Text.Encoding]::UTF8.GetBytes($line); $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true)} finally {$stream.Dispose()}
    [IO.File]::WriteAllText((Join-Path $Backup 'status'),$Phase)
}
function Assert-NoReparseTree($Root) {
    if (Test-Path -LiteralPath $Root) {
        $items = @((Get-Item -LiteralPath $Root)) + @(Get-ChildItem -LiteralPath $Root -Recurse -Force)
        if ($items | Where-Object {($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0}) {throw 'REPARSE_POINT_REQUIRES_REVIEW'}
    }
}
function Get-RuntimeProcesses($Root) {
    $exe = Join-Path $Root 'node\node.exe'
    @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
        if (-not $_.ExecutablePath) {throw 'PROCESS_PATH_UNAVAILABLE'}
        $_.ExecutablePath.Equals($exe,[StringComparison]::OrdinalIgnoreCase)
    })
}
function Assert-RuntimeProcess($Process, $Root, $OwnerSid) {
    if (-not $Process.ExecutablePath -or -not $Process.ExecutablePath.Equals((Join-Path $Root 'node\node.exe'),[StringComparison]::OrdinalIgnoreCase)) {throw 'PROCESS_PATH_MISMATCH'}
    $owner = Invoke-CimMethod -InputObject $Process -MethodName GetOwnerSid
    if ($owner.ReturnValue -ne 0 -or $owner.Sid -ne $OwnerSid) {throw 'PROCESS_OWNER_MISMATCH'}
    $q = '["'']?'
    $exe = [regex]::Escape((Join-Path $Root 'node\node.exe'))
    $super = [regex]::Escape((Join-Path $Root 'runtime\supervisor.mjs'))
    $server = [regex]::Escape((Join-Path $Root 'app\server.js'))
    $enroll = [regex]::Escape((Join-Path $Root 'runtime\enrollment.mjs'))
    $preload = [regex]::Escape((Join-Path $Root 'runtime\devspace-session-preload.mjs'))
    $cli = [regex]::Escape((Join-Path $Root 'devspace\node_modules\@waishnav\devspace\dist\cli.js'))
    $allowed = "^$q$exe$q\s+(?:$q$super$q\s+(?:router|devspace|outbound)|$q$server$q|$q$enroll$q\s+run|--import\s+$q$preload$q\s+$q$cli$q\s+serve)\s*$"
    if (-not $Process.CommandLine -or $Process.CommandLine -notmatch $allowed) {throw 'PROCESS_COMMAND_REQUIRES_REVIEW'}
}
function Assert-RuntimeTask($Task, $Root, $OwnerSid) {
    $account = New-Object Security.Principal.NTAccount($Task.Principal.UserId)
    $sid = $account.Translate([Security.Principal.SecurityIdentifier]).Value
    $modes = @{'CodasSol Standalone V02 DevSpace'='devspace';'CodasSol Standalone V02 Router'='router';'CodasSol Standalone V02 Outbound'='outbound'}
    $mode = $modes[$Task.TaskName]
    if (-not $mode -or $sid -ne $OwnerSid -or $Task.TaskPath -ne '\' -or $Task.Actions.Count -ne 1 -or
        $Task.Actions[0].Execute -ine (Join-Path $Root 'node\node.exe') -or
        $Task.Actions[0].Arguments -cne ('"' + (Join-Path $Root 'runtime\supervisor.mjs') + '" ' + $mode)) {throw 'TASK_OWNERSHIP_REQUIRES_REVIEW'}
}
function Stop-OwnedRuntime($Root, $Names, $OwnerSid) {
    # Validate all candidates before any stop. Never kill all node.exe processes.
    $found = @()
    foreach ($name in $Names) {
        $task = Get-ScheduledTask -TaskName $name -TaskPath '\' -ErrorAction SilentlyContinue
        if ($task) {Assert-RuntimeTask $task $Root $OwnerSid; $found += $task}
    }
    foreach ($p in (Get-RuntimeProcesses $Root)) {Assert-RuntimeProcess $p $Root $OwnerSid}
    foreach ($task in $found) {Disable-ScheduledTask -InputObject $task | Out-Null; Stop-ScheduledTask -InputObject $task}
    $until = [DateTime]::UtcNow.AddSeconds(20)
    do {
        $remaining = @(Get-RuntimeProcesses $Root)
        foreach ($p in $remaining) {
            Assert-RuntimeProcess $p $Root $OwnerSid
            $fresh = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ProcessId)"
            if ($fresh) {
                if ($fresh.CreationDate -ne $p.CreationDate) {throw 'PROCESS_ID_REUSED'}
                Assert-RuntimeProcess $fresh $Root $OwnerSid
                Stop-Process -Id $fresh.ProcessId -ErrorAction Stop
            }
        }
        if (-not $remaining.Count) {return}
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $until)
    throw 'RUNTIME_STOP_TIMEOUT'
}
function Copy-VerifiedTree($Source, $Destination) {
    Assert-NoReparseTree $Source
    if (Test-Path -LiteralPath $Destination) {throw 'STAGE_ALREADY_EXISTS'}
    Copy-Item -LiteralPath $Source -Destination $Destination -Recurse -ErrorAction Stop
    foreach ($file in (Get-ChildItem -LiteralPath $Source -File -Recurse -Force)) {
        $relative = $file.FullName.Substring($Source.TrimEnd('\').Length).TrimStart('\')
        if ((Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath (Join-Path $Destination $relative) -Algorithm SHA256).Hash) {throw 'SNAPSHOT_HASH_MISMATCH'}
    }
}
function Switch-RuntimeForRollback($Root, $Backup, $Rename = {param($a,$b) [IO.Directory]::Move($a,$b)}) {
    # Same-parent Directory.Move is a rename, never Move-Item's partial file walk.
    $suffix = [guid]::NewGuid().ToString('N')
    $stage = $Root + '.restore-' + $suffix
    $failed = $Root + '.failed-' + $suffix
    $old = Join-Path $Backup 'runtime'
    if (Test-Path -LiteralPath $old) {Copy-VerifiedTree $old $stage}
    Assert-NoReparseTree $Root
    Write-RecoveryJournal $Backup 'ROLLBACK_STAGED' @{stage=$stage; failed=$failed}
    if (Test-Path -LiteralPath $Root) {& $Rename $Root $failed}
    Write-RecoveryJournal $Backup 'CANDIDATE_QUARANTINED' @{failed=$failed; stage=$stage}
    if (Test-Path -LiteralPath $stage) {
        try {& $Rename $stage $Root} catch {
            if (-not (Test-Path -LiteralPath $Root) -and (Test-Path -LiteralPath $failed)) {& $Rename $failed $Root}
            throw
        }
    }
    Write-RecoveryJournal $Backup 'RUNTIME_RESTORED' @{failed=$failed}
}
