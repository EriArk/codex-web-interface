#Requires -RunAsAdministrator
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$HubAddress,
      [Parameter(Mandatory=$true)][string]$Program,
      [Parameter(Mandatory=$true)][ValidateSet(22,5900)][int]$Port)
$ErrorActionPreference = 'Stop'
if ($HubAddress -notmatch '^100\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$' -or [int]$Matches[1] -lt 64 -or [int]$Matches[1] -gt 127 -or [int]$Matches[2] -gt 255 -or [int]$Matches[3] -gt 255) { throw 'Invalid Hub Tailscale address.' }
$expected = if ($Port -eq 22) { Join-Path $env:WINDIR 'System32\OpenSSH\sshd.exe' } else { Join-Path $env:ProgramFiles 'TightVNC\tvnserver.exe' }
if ($Program -ne $expected) { throw 'Unexpected service executable.' }
if (@(Get-NetFirewallProfile -PolicyStore ActiveStore | Where-Object { [string]$_.Enabled -ne 'True' }).Count) { throw 'Включите брандмауэр Windows и повторите завершение подключения.' }
$octets = @($HubAddress.Split('.') | ForEach-Object { [int]$_ })
$number = [long]$octets[0]*16777216 + [long]$octets[1]*65536 + [long]$octets[2]*256 + $octets[3]
function Convert-CwIPv4([long]$value) { return ((@(24,16,8,0 | ForEach-Object { ($value -shr $_) -band 255 })) -join '.') }
$before = Convert-CwIPv4 ($number-1)
$after = Convert-CwIPv4 ($number+1)
# Explicit blocks override unrelated allow rules; only the enrolled native service/port is affected.
# NetSecurity rejects the IPv6 zero-length prefix (::/0). Two /1 prefixes cover IPv6.
$ranges = @("0.0.0.0-$before", "$after-255.255.255.255", '::/1', '8000::/1')
$name = "CodexWeb-Enrolled-Private-$Port"
if (Get-NetFirewallRule -Name $name -ErrorAction SilentlyContinue) {
    Set-NetFirewallRule -Name $name -Enabled True -Direction Inbound -Action Block -Protocol TCP -LocalPort $Port -RemoteAddress $ranges -Program $Program -Profile Any | Out-Null
} else {
    New-NetFirewallRule -Name $name -DisplayName "CodexWeb private service $Port" -Direction Inbound -Action Block -Protocol TCP -LocalPort $Port -RemoteAddress $ranges -Program $Program -Profile Any | Out-Null
}
$rule = Get-NetFirewallRule -PolicyStore ActiveStore -Name $name
$ports = $rule | Get-NetFirewallPortFilter
$app = $rule | Get-NetFirewallApplicationFilter
$addresses = @(($rule | Get-NetFirewallAddressFilter).RemoteAddress)
if (@($rule).Count -ne 1 -or [string]$rule.Enabled -ne 'True' -or [string]$rule.Action -ne 'Block' -or [string]$rule.Direction -ne 'Inbound' -or [string]$rule.Profile -ne 'Any' -or [string]$ports.Protocol -notin @('TCP','6') -or [string]$ports.LocalPort -ne [string]$Port -or [string]$app.Program -ne $Program -or @(Compare-Object $ranges $addresses).Count) { throw 'Не удалось применить приватное правило подключения.' }
Write-Host "Private boundary ready for port $Port. Unrelated Windows rules preserved."
