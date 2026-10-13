<#
  CodasSol File Sentinel, Windows PowerShell 5.1+
  Metadata only: no content collection, file modification or automatic repair.
  FileSystemWatcher gives event time; SHA-256 scans confirm persistent changes.
  Neither source identifies the process that caused the change.
#>
param(
  [string[]]$Roots = @(
    (Join-Path $env:USERPROFILE 'Desktop\CodasSol-Windows-Outbound-SSE\CodasSol-Windows-Outbound-SSE'),
    (Join-Path $env:LOCALAPPDATA 'CodasSol\NodeV02Standalone\app'),
    (Join-Path $env:LOCALAPPDATA 'CodasSol\NodeV02Standalone\runtime')
  ),
  [string]$LogDir = (Join-Path $env:LOCALAPPDATA 'CodasSol\Diagnostics\FileSentinel'),
  [int]$ScanSeconds = 10,
  [int]$RunSeconds = 0,
  [switch]$Once
)
$ErrorActionPreference = 'Stop'
if ($ScanSeconds -lt 2) { throw 'ScanSeconds must be >= 2' }
$componentDir = Join-Path $env:LOCALAPPDATA 'CodasSol\Diagnostics'
$configPath = Join-Path $componentDir 'sentinel-roots.json'
if (-not $PSBoundParameters.ContainsKey('Roots') -and (Test-Path -LiteralPath $configPath)) {
  $settings = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
  if ($settings -and $settings.roots) { $Roots = @($settings.roots) }
}
New-Item -Path $LogDir -ItemType Directory -Force | Out-Null
$baseline = Join-Path $LogDir 'baseline.json'
$jsonl = Join-Path $LogDir 'events.jsonl'
$sourcePrefix = "CodasSentinel-$PID-"
$watches = New-Object System.Collections.ArrayList
$subIds = New-Object System.Collections.ArrayList
$recent = @{}

function Record([string]$kind, [string]$file, [string]$detail, [string]$source) {
  $now = Get-Date
  $entry = [ordered]@{ time = $now.ToString('o'); kind = $kind; path = $file; detail = $detail; origin = $source }
  $entry | ConvertTo-Json -Compress | Add-Content -LiteralPath $jsonl -Encoding UTF8
  $md = Join-Path $LogDir ('changes-' + $now.ToString('yyyy-MM-dd') + '.md')
  if (-not (Test-Path -LiteralPath $md)) {
    @('# CodasSol File Sentinel — ' + $now.ToString('yyyy-MM-dd'), '',
      'File events are evidence of changes, **not proof of the process responsible**.', '') |
      Set-Content -LiteralPath $md -Encoding UTF8
  }
  $clean = ($file + ' — ' + $detail) -replace '[\r\n]', ' '
  Add-Content -LiteralPath $md -Encoding UTF8 -Value ('- **' + $now.ToString('o') + '** [' + $kind + '] ' + $clean + ' (' + $source + ')')
}

function Snapshot {
  $items = @{}
  foreach ($root in $Roots) {
    if (-not (Test-Path -LiteralPath $root -PathType Container)) { continue }
    foreach ($f in (Get-ChildItem -LiteralPath $root -Recurse -File -Force -ErrorAction SilentlyContinue)) {
      try {
        $hash = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256 -ErrorAction Stop).Hash
      } catch {
        $hash = 'UNREADABLE'
      }
      $items[$f.FullName.ToLowerInvariant()] = [ordered]@{
        path = $f.FullName; hash = $hash; size = $f.Length; modifiedUtc = $f.LastWriteTimeUtc.ToString('o')
      }
    }
  }
  return ,$items
}

function ReadBaseline {
  $items = @{}
  if (Test-Path -LiteralPath $baseline) {
    # PowerShell 5.1 ConvertFrom-Json emits an array as one pipeline object.
    $decoded = Get-Content -LiteralPath $baseline -Raw | ConvertFrom-Json
    foreach ($f in $decoded) {
      if ($null -ne $f -and $f.path) { $items[$f.path.ToLowerInvariant()] = $f }
    }
  }
  return ,$items
}

function WriteBaseline($snapshot) {
  $tmp = Join-Path $LogDir ('baseline-' + $PID + '.tmp')
  ConvertTo-Json -InputObject @($snapshot.Values | Sort-Object path) -Depth 4 |
    Set-Content -LiteralPath $tmp -Encoding UTF8
  Move-Item -LiteralPath $tmp -Destination $baseline -Force
}

function Compare($previous, $current, [string]$source) {
  $changes = 0
  foreach ($id in @($previous.Keys)) {
    if (-not $current.ContainsKey($id)) {
      Record 'DELETED' $previous[$id].path ('previous_sha256=' + $previous[$id].hash) $source
      $changes++
    } elseif ($previous[$id].hash -ne $current[$id].hash) {
      Record 'MODIFIED' $current[$id].path ('sha256=' + $previous[$id].hash + ' -> ' + $current[$id].hash) $source
      $changes++
    }
  }
  foreach ($id in @($current.Keys)) {
    if (-not $previous.ContainsKey($id)) {
      Record 'CREATED' $current[$id].path ('sha256=' + $current[$id].hash) $source
      $changes++
    }
  }
  return $changes
}

$before = ReadBaseline
$current = Snapshot
if (-not (Test-Path -LiteralPath $baseline)) {
  Record 'BASELINE' '' ('tracked_files=' + $current.Count) 'initial scan'
} else {
  [void](Compare $before $current 'restart scan')
}
WriteBaseline $current
if ($Once) { Write-Output ('Scanned ' + $current.Count + ' files; logs: ' + $LogDir); exit 0 }

try {
  foreach ($root in $Roots) {
    if (-not (Test-Path -LiteralPath $root -PathType Container)) {
      Record 'ROOT_MISSING' $root 'Missing on startup' 'monitor'
      continue
    }
    $fs = New-Object System.IO.FileSystemWatcher
    $fs.Path = $root
    $fs.IncludeSubdirectories = $true
    $fs.NotifyFilter = [System.IO.NotifyFilters]'FileName,DirectoryName,LastWrite,Size,CreationTime'
    foreach ($eventName in @('Created','Changed','Deleted','Renamed','Error')) {
      $id = $sourcePrefix + $watches.Count + '-' + $eventName
      Register-ObjectEvent -InputObject $fs -EventName $eventName -SourceIdentifier $id | Out-Null
      [void]$subIds.Add($id)
    }
    $fs.EnableRaisingEvents = $true
    [void]$watches.Add($fs)
  }
  Record 'STARTED' '' ('watchers=' + $watches.Count + '; scan_seconds=' + $ScanSeconds) 'monitor'
  $started = Get-Date
  $nextScan = $started.AddSeconds($ScanSeconds)
  while ($true) {
    Start-Sleep -Milliseconds 500
    foreach ($ev in @(Get-Event | Where-Object { $_.SourceIdentifier -like ($sourcePrefix + '*') })) {
      $args = $ev.SourceEventArgs
      if ($args -is [System.IO.ErrorEventArgs]) {
        $kind = 'WATCHER_ERROR'; $path = ''; $detail = $args.GetException().Message
      } else {
        $kind = 'FS_' + $args.ChangeType.ToString().ToUpperInvariant()
        $path = [string]$args.FullPath
        $detail = 'Process identity unavailable'
        if ($args -is [System.IO.RenamedEventArgs]) { $detail = 'From: ' + $args.OldFullPath }
      }
      $key = $kind + '|' + $path + '|' + $detail
      $time = Get-Date
      if (-not $recent.ContainsKey($key) -or ($time - $recent[$key]).TotalSeconds -ge 2) {
        Record $kind $path $detail 'FileSystemWatcher'
        $recent[$key] = $time
      }
      Remove-Event -EventIdentifier $ev.EventIdentifier
    }
    if ((Get-Date) -ge $nextScan) {
      $updated = Snapshot
      $count = Compare $current $updated 'SHA256 scan'
      $current = $updated
      if ($count -gt 0) { WriteBaseline $current }
      if ($recent.Count -gt 2000) { $recent.Clear() }
      $nextScan = (Get-Date).AddSeconds($ScanSeconds)
    }
    if ($RunSeconds -gt 0 -and ((Get-Date) - $started).TotalSeconds -ge $RunSeconds) { break }
  }
} finally {
  foreach ($id in $subIds) { Unregister-Event -SourceIdentifier $id -ErrorAction SilentlyContinue }
  foreach ($fs in $watches) { $fs.Dispose() }
  Record 'STOPPED' '' 'Watcher exiting' 'monitor'
}
