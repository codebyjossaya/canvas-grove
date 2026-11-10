$ErrorActionPreference = 'Stop'
$docker = 'D:\CanvasGrove\DockerDesktop\Docker\resources\bin\docker.exe'
$services = @('postgres', 'browser-orchestrator', 'app', 'lan-gateway', 'sync-worker')

& $docker --context desktop-linux compose --env-file .env.docker restart app sync-worker
if ($LASTEXITCODE -ne 0) { throw 'Could not restart the app and sync worker' }
for ($attempt = 0; $attempt -lt 20; $attempt++) {
  Start-Sleep -Seconds 3
  $rows = & $docker --context desktop-linux compose --env-file .env.docker ps --format json | ConvertFrom-Json
  $app = $rows | Where-Object Service -eq 'app'
  if ($app.State -eq 'running' -and $app.Health -eq 'healthy') { break }
}
foreach ($service in $services) {
  $row = $rows | Where-Object Service -eq $service
  if (-not $row -or $row.State -ne 'running') { throw "$service is not running" }
  if ($row.Health -and $row.Health -ne 'healthy') { throw "$service is not healthy" }
}

$workerLogs = & $docker --context desktop-linux compose --env-file .env.docker logs --since 2m --tail 100 sync-worker
if ($LASTEXITCODE -ne 0 -or ($workerLogs -join "`n") -match '(?i)uncaught|fatal|unhandled') {
  throw 'The sync worker reported an unhealthy restart'
}
Write-Output 'Compose acceptance passed: core services running and sync worker restart healthy.'
