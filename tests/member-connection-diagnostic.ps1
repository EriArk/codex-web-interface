#Requires -Version 5.1
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\ops\windows\Test-CodexWebConnection.ps1') -NoPause
function Assert-Cw($Value, [string]$Message) { if (-not $Value) { throw $Message } }
# Validate actual firewall predicate using synthetic Windows filters.
$script:addresses = @('0.0.0.0-100.79.63.55','100.79.63.57-255.255.255.255','::/1','8000::/1')
$script:firewallEnabled = 'True'
function Get-NetFirewallProfile { param($PolicyStore) return [pscustomobject]@{Enabled=$script:firewallEnabled} }
function Get-NetFirewallRule { param($PolicyStore,$Name,$ErrorAction) return [pscustomobject]@{Enabled='True';Action='Block';Direction='Inbound';Profile='Any'} }
function Get-NetFirewallPortFilter { return [pscustomobject]@{Protocol='TCP';LocalPort=22} }
function Get-NetFirewallApplicationFilter { return [pscustomobject]@{Program=(Join-Path $env:WINDIR 'System32\OpenSSH\sshd.exe')} }
function Get-NetFirewallAddressFilter { return [pscustomobject]@{RemoteAddress=$script:addresses} }
Assert-Cw (Test-CwSshBoundary '100.79.63.56') 'Valid Hub-only firewall rejected'
$script:firewallEnabled='False'
Assert-Cw (-not (Test-CwSshBoundary '100.79.63.56')) 'Disabled firewall accepted'
$script:firewallEnabled='True'; $script:addresses=@('0.0.0.0/0')
Assert-Cw (-not (Test-CwSshBoundary '100.79.63.56')) 'Wrong firewall ranges accepted'
$script:starts = @(); $script:services = @{ Tailscale = 'Stopped'; sshd = 'Stopped' }; $script:boundary = $true
function Get-Service { param($Name, $ErrorAction) return [pscustomobject]@{Status=$script:services[$Name];StartType='Automatic'} }
function Start-Service { param($Name, $ErrorAction) $script:starts += $Name }
function Test-CwSshBoundary { param($HubAddress) return $script:boundary }
[void](Repair-CwServices $false $true '100.79.63.56')
[void](Repair-CwServices $true $false '100.79.63.56')
Assert-Cw ($script:starts.Count -eq 0) 'Wrong user or unprivileged recovery started services'
[void](Repair-CwServices $true $true '100.79.63.56')
Assert-Cw (($script:starts -join ',') -eq 'Tailscale,sshd') 'Stopped services not started'
$script:starts = @(); $script:services.Tailscale='Running'; $script:services.sshd='Running'
[void](Repair-CwServices $true $true '100.79.63.56')
Assert-Cw ($script:starts.Count -eq 0) 'Running service was touched'
$script:services.sshd='Stopped'; $script:boundary=$false
[void](Repair-CwServices $true $true '100.79.63.56')
Assert-Cw ($script:starts.Count -eq 0) 'SSH started without private firewall boundary'
# All diagnostic operations below are fixtures. No real service, account, task or network mutation.
function Invoke-CwDiagnosticCommand { param($File,$Arguments) return @{code=0;text='{"BackendState":"NeedsLogin","AuthURL":"SECRET_LOGIN_URL","Self":{"Online":false,"PublicKey":"SECRET_KEY"},"TailscaleIPs":[],"Peer":{},"CurrentTailnet":{"Name":"fixture"}}'} }
function Get-ItemProperty { param($LiteralPath) return [pscustomobject]@{MachineGuid='fixture-guid'} }
function Get-NetTCPConnection { param($State,$LocalPort,$ErrorAction) throw 'Fixture unavailable' }
function Get-NetFirewallRule { param($PolicyStore,$ErrorAction) throw 'Fixture unavailable' }
function Get-ScheduledTask { param($TaskName,$ErrorAction) return [pscustomobject]@{State='Ready';Principal=[pscustomobject]@{UserId='fixture'}} }
function Get-ScheduledTaskInfo { param($TaskName,$ErrorAction) return [pscustomobject]@{LastTaskResult=0;LastRunTime=[DateTime]::UtcNow} }
function Get-FileHash { param($LiteralPath,$Algorithm,$ErrorAction) return [pscustomobject]@{Hash=('a'*64)} }
function Get-Command { param($Name,$ErrorAction) return [pscustomobject]@{Source=('C:\Tools\'+$Name)} }
$OutputDirectory=Join-Path $PSScriptRoot ('..\.cache\diagnostic-test-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$ConnectionFile=Join-Path $OutputDirectory 'target.json'
@{hubAddress='100.79.63.56';sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;machineGuid='fixture-guid'} | ConvertTo-Json | Set-Content -LiteralPath $ConnectionFile -Encoding UTF8
$RepairExistingServices=$false
Invoke-CwConnectionDiagnostic
$report=Get-ChildItem -LiteralPath $OutputDirectory -Filter 'CodexWeb*.json' | Select-Object -First 1
$text=Get-Content -LiteralPath $report.FullName -Raw -Encoding UTF8
$data=$text | ConvertFrom-Json
Assert-Cw ($data.expectedComputer -and $data.expectedUser) 'Binding diagnostic incorrect'
Assert-Cw ($data.tailscale.state -eq 'NeedsLogin') 'Tailscale diagnostic incorrect'
Assert-Cw ($data.helpers.Count -eq 6 -and $data.tasks.Count -eq 3) 'Helper diagnostic incomplete'
Assert-Cw ($text -notmatch 'SECRET_|AuthURL|PublicKey') 'Sensitive field leaked into report'
Assert-Cw ($script:starts.Count -eq 0) 'Read-only diagnostic started services'
Write-Host 'PASS: identity/admin gates, idle-service recovery, private SSH boundary, running service preservation, read-only report and secret exclusion'
