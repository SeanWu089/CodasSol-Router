param([string]$Roots = '', [string]$RouterUrl = '', [switch]$LocalOnly,
      [switch]$SkipSentinelPrompt, [switch]$InstallFileSentinel)
$ErrorActionPreference = 'Stop'
$base = Join-Path $env:LOCALAPPDATA 'CodasSol'
$root = Join-Path $base 'NodeV02Standalone'
$state = Join-Path $env:USERPROFILE '.codassol-node-v02'
$config = Join-Path $env:USERPROFILE '.devspace\config.jsonc'
$tasks = @('CodasSol Standalone V02 DevSpace','CodasSol Standalone V02 Router','CodasSol Standalone V02 Outbound')
$lock = Join-Path $base 'standalone-install.lock'
New-Item -ItemType Directory -Force $base | Out-Null
# Exclusive open remains held across child execution, and releases on process death.
$handle = [IO.File]::Open($lock, 'OpenOrCreate', 'ReadWrite', 'None')
$backup = Join-Path $base ('Backups\candidate-' + [guid]::NewGuid().ToString('N'))
try {
    New-Item -ItemType Directory -Path $backup | Out-Null
    $records = @()
    foreach ($name in $tasks) {
        $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
        if ($task) {
            $account = New-Object Security.Principal.NTAccount($task.Principal.UserId)
            if ($account.Translate([Security.Principal.SecurityIdentifier]).Value -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value -or
                $task.Actions.Count -ne 1 -or $task.Actions[0].Arguments -notlike ('*' + $root + '\runtime\*')) {
                throw "Foreign task: $name. Installation stopped before mutation."
            }
            $records += @{name=$name; running=($task.State -eq 'Running'); xml=(Export-ScheduledTask -TaskName $name)}
        }
    }
    # Private backup remains on this Windows user's disk; never upload it.
    $records | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $backup 'tasks.json') -Encoding UTF8
    foreach ($entry in @(@($root,'runtime'),@($state,'state'),@($config,'config.jsonc'))) {
        if (Test-Path -LiteralPath $entry[0]) { Copy-Item -LiteralPath $entry[0] -Destination (Join-Path $backup $entry[1]) -Recurse }
    }
    [IO.File]::WriteAllText((Join-Path $backup 'status'), 'PREPARED')
    try {
        $args = @('-NoLogo','-NoProfile','-File',(Join-Path $PSScriptRoot 'install.ps1'),'-TransactionManaged')
        if ($Roots) {$args += @('-Roots',$Roots)}
        if ($RouterUrl) {$args += @('-RouterUrl',$RouterUrl)}
        if ($LocalOnly) {$args += '-LocalOnly'}
        if ($SkipSentinelPrompt) {$args += '-SkipSentinelPrompt'}
        if ($InstallFileSentinel) {throw 'Install optional Sentinel separately after candidate acceptance.'}
        & powershell.exe @args
        if ($LASTEXITCODE -ne 0) {throw "Installer exited $LASTEXITCODE"}
        [IO.File]::WriteAllText((Join-Path $backup 'status'), 'VERIFIED_LOCAL')
        Write-Host "Rollback snapshot retained privately: $backup"
    } catch {
        $failure = $_
        foreach ($name in $tasks) {
            Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
            Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
        }
        if (Test-Path -LiteralPath $root) {Move-Item -LiteralPath $root -Destination (Join-Path $backup 'failed-runtime')}
        if (Test-Path (Join-Path $backup 'runtime')) {Copy-Item -LiteralPath (Join-Path $backup 'runtime') -Destination $root -Recurse}
        # Never rewind identity, OAuth state or session-generation reservations.
        $oldRoots = Join-Path $backup 'state\roots.txt'
        if (Test-Path $oldRoots) {Copy-Item -LiteralPath $oldRoots -Destination (Join-Path $state 'roots.txt') -Force}
        if (Test-Path (Join-Path $backup 'config.jsonc')) {Copy-Item -LiteralPath (Join-Path $backup 'config.jsonc') -Destination $config -Force}
        foreach ($record in $records) {
            Register-ScheduledTask -TaskName $record.name -Xml $record.xml -Force | Out-Null
            if ($record.running) {Start-ScheduledTask -TaskName $record.name}
        }
        [IO.File]::WriteAllText((Join-Path $backup 'status'), 'ROLLED_BACK')
        throw $failure
    }
} finally {$handle.Dispose()}
