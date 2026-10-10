$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$node = Join-Path $root 'node\node.exe'
$cli = Join-Path $root 'devspace\node_modules\@waishnav\devspace\dist\cli.js'
$env:PATH = "$(Join-Path $root 'node');$env:PATH"
$logDir = Join-Path $root 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
while ($true) {
    try {
        $h = Invoke-RestMethod -Uri 'http://127.0.0.1:7676/healthz' -TimeoutSec 3
        if ($h.ok -eq $true -and $h.name -eq 'devspace') {
            Start-Sleep -Seconds 5
            continue
        }
    } catch { }
    if (-not (Test-Path -LiteralPath $node) -or -not (Test-Path -LiteralPath $cli)) {
        ('{0} Missing Node or DevSpace CLI; check software protection logs / integrity.' -f (Get-Date -Format o)) |
            Out-File -LiteralPath (Join-Path $logDir 'devspace-supervisor.log') -Append -Encoding utf8
        Start-Sleep -Seconds 20
        continue
    }
    try {
        Set-Location $env:USERPROFILE
        & $node $cli serve 2>&1 |
            Out-File -LiteralPath (Join-Path $logDir 'devspace.log') -Append -Encoding utf8
    } catch {
        ('{0} DevSpace exited: {1}' -f (Get-Date -Format o), $_.Exception.Message) |
            Out-File -LiteralPath (Join-Path $logDir 'devspace-supervisor.log') -Append -Encoding utf8
    }
    Start-Sleep -Seconds 5
}
