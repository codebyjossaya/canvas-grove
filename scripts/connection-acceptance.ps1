param(
  [switch]$Watch,
  [int]$PollSeconds = 5,
  [int]$TimeoutSeconds = 600
)

$ErrorActionPreference = 'Stop'
$docker = 'D:\CanvasGrove\DockerDesktop\Docker\resources\bin\docker.exe'
$started = Get-Date
$last = ''

do {
  $rows = & $docker --context desktop-linux compose --env-file .env.docker ps --format json | ConvertFrom-Json
  $coreReady = @('app', 'browser-orchestrator', 'lan-gateway', 'postgres', 'sync-worker') | ForEach-Object {
    $row = $rows | Where-Object Service -eq $_
    [pscustomobject]@{ service = $_; running = $row.State -eq 'running'; health = $row.Health }
  }
  $states = & $docker --context desktop-linux exec canvas-grove-postgres-1 psql -U canvas_grove_admin -d canvas_grove -Atc `
    "select status || ':' || count(*) from hosted_browser_sessions group by status order by status"
  $browserCount = [int](& $docker --context desktop-linux ps --filter 'label=canvas.browser.managed=true' --format '{{.ID}}' | Measure-Object).Count
  $recent = & $docker --context desktop-linux compose --env-file .env.docker logs --since 2m --tail 300 browser-orchestrator lan-gateway sync-worker 2>&1
  $summary = [ordered]@{
    servicesReady = @($coreReady | Where-Object { -not $_.running -or ($_.health -and $_.health -ne 'healthy') }).Count -eq 0
    sessionStates = @($states)
    managedBrowsers = $browserCount
    browserReadyEvents = @($recent | Select-String 'browser_ready').Count
    browserClaimedEvents = @($recent | Select-String 'browser_claimed').Count
    liveUrlEvents = @($recent | Select-String 'live_url_issued').Count
    connectSuccesses = @($recent | Select-String 'POST /api/canvas/sessions/.*/connect HTTP/1.1" 200').Count
    connectFailures = @($recent | Select-String 'POST /api/canvas/sessions/.*/connect HTTP/1.1" 5[0-9][0-9]').Count
  }
  $json = $summary | ConvertTo-Json -Compress
  if ($json -ne $last) { Write-Output $json; $last = $json }
  if (-not $Watch) { break }
  if ($summary.sessionStates -match '^active:' -and $summary.liveUrlEvents -gt 0) { break }
  Start-Sleep -Seconds $PollSeconds
} while (((Get-Date) - $started).TotalSeconds -lt $TimeoutSeconds)

if (-not $summary.servicesReady) { throw 'One or more core services are not ready' }
