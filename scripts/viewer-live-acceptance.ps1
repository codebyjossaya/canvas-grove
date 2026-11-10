param([int]$Runs = 1, [string[]]$CleanupSessionIds = @(), [string]$CanvasOrigin = 'https://canvas.instructure.com', [ValidateSet('/login','/login/saml')][string]$LoginPath = '/login')

$ErrorActionPreference = 'Stop'
$docker = 'D:\CanvasGrove\DockerDesktop\Docker\resources\bin\docker.exe'
$container = 'canvas-grove-browser-orchestrator-1'

function Invoke-SignedOrchestrator([string]$Method, [string]$Path, [string]$Body = '') {
  $program = @'
const {createHmac,randomBytes}=require('crypto');
const method=process.argv[1], path=process.argv[2], body=Buffer.from(process.argv[3]||'','base64').toString('utf8');
const timestamp=String(Date.now()), nonce=randomBytes(16).toString('base64url');
const signature=createHmac('sha256',process.env.BROWSER_ORCHESTRATOR_SECRET).update(`${method}\n${path}\n${timestamp}\n${nonce}\n${body}`).digest('base64url');
fetch(`http://127.0.0.1:8080${path}`,{method,headers:{'content-type':'application/json','x-orchestrator-timestamp':timestamp,'x-orchestrator-nonce':nonce,'x-orchestrator-signature':signature},body:body||undefined}).then(async response=>{const text=await response.text();if(!response.ok)throw new Error(`${response.status} ${text}`);process.stdout.write(text)}).catch(error=>{console.error(error.message);process.exit(1)});
'@
  $encodedBody = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Body))
  $raw = & $docker --context desktop-linux exec $container node -e $program $Method $Path $encodedBody
  if ($LASTEXITCODE -ne 0) { throw "Orchestrator request failed: $Method $Path" }
  return $raw | ConvertFrom-Json
}

if ($CleanupSessionIds.Count -gt 0) {
  foreach ($id in $CleanupSessionIds) { Invoke-SignedOrchestrator DELETE "/v1/sessions/$id" | Out-Null }
  exit 0
}

for ($run = 1; $run -le $Runs; $run += 1) {
  $session = $null
  try {
    $createBody = @{ canvasOrigin = $CanvasOrigin.TrimEnd('/'); authHostRules = @(); loginPath = $LoginPath; display = @{ width = 1280; height = 720 } } | ConvertTo-Json -Compress
    $session = Invoke-SignedOrchestrator POST '/v1/sessions' $createBody
    $navigateBody = @{ url = "$($CanvasOrigin.TrimEnd('/'))$LoginPath" } | ConvertTo-Json -Compress
    Invoke-SignedOrchestrator POST "/v1/sessions/$($session.id)/navigate" $navigateBody | Out-Null
    $live = Invoke-SignedOrchestrator POST "/v1/sessions/$($session.id)/live"
    $env:VIEWER_ACCEPTANCE_URL = $live.url
    node scripts/viewer-live-acceptance.mjs
    if ($LASTEXITCODE -ne 0) { throw "Viewer acceptance run $run failed" }
    Invoke-SignedOrchestrator POST "/v1/sessions/$($session.id)/revoke-live" | Out-Null
    $reconnected = Invoke-SignedOrchestrator POST "/v1/sessions/$($session.id)/live"
    $env:VIEWER_ACCEPTANCE_URL = $reconnected.url
    node scripts/viewer-live-acceptance.mjs
    if ($LASTEXITCODE -ne 0) { throw "Viewer acceptance reconnect run $run failed" }
  } finally {
    Remove-Item Env:VIEWER_ACCEPTANCE_URL -ErrorAction SilentlyContinue
    if ($null -ne $session -and $session.id) {
      Invoke-SignedOrchestrator DELETE "/v1/sessions/$($session.id)" | Out-Null
      $remaining = & $docker --context desktop-linux ps -a --filter "name=^canvas-browser-$($session.id)$" --format '{{.ID}}'
      if ($remaining) { throw "Temporary browser container survived DELETE: $($session.id)" }
    }
  }
}
