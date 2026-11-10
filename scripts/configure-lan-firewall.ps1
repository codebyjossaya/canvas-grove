$ErrorActionPreference = 'Stop'
$ruleName = 'Canvas Grove LAN (Private LocalSubnet TCP 3000)'
$profile = Get-NetConnectionProfile -InterfaceAlias 'Wi-Fi'
if ($profile.NetworkCategory -ne 'Private') {
  Set-NetConnectionProfile -InterfaceAlias 'Wi-Fi' -NetworkCategory Private
}
Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3000 -Profile Private -RemoteAddress LocalSubnet | Out-Null
$verifiedProfile = Get-NetConnectionProfile -InterfaceAlias 'Wi-Fi'
$rule = Get-NetFirewallRule -DisplayName $ruleName
$port = $rule | Get-NetFirewallPortFilter
$address = $rule | Get-NetFirewallAddressFilter
if ($verifiedProfile.NetworkCategory -ne 'Private' -or $rule.Profile -notmatch 'Private' -or $port.LocalPort -ne '3000' -or $address.RemoteAddress -notcontains 'LocalSubnet') {
  throw 'LAN firewall verification failed'
}
Set-Content -LiteralPath (Join-Path $PSScriptRoot '.lan-firewall-ok') -Value 'ok' -NoNewline
