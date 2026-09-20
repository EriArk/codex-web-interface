$ErrorActionPreference='Stop'
$repo=Split-Path -Parent $PSScriptRoot
$source=Join-Path $repo 'ops\windows'
foreach($file in @('Start-FinishEnrollment.ps1','Finish-Enrollment.ps1','Set-EnrollmentFirewallBoundary.ps1')) {
 $tokens=$null;$errors=$null
 [void][Management.Automation.Language.Parser]::ParseInput([IO.File]::ReadAllText((Join-Path $source $file)),[ref]$tokens,[ref]$errors)
 if($errors.Count){throw ($errors.Message -join '; ')}
}
$script:created=$null
function Get-NetFirewallProfile { [pscustomobject]@{Enabled='True'} }
function Get-NetFirewallRule {param($Name,$PolicyStore) if($script:created){[pscustomobject]@{Enabled='True';Action='Block';Direction='Inbound';Profile='Any'}} }
function Remove-NetFirewallRule {param($Name) $script:created=$null }
function New-NetFirewallRule {param($Name,$DisplayName,$Direction,$Action,$Protocol,$LocalPort,$RemoteAddress,$Program,$Profile) $script:created=@{Program=$Program;RemoteAddress=$RemoteAddress;Port=$LocalPort} }
function Get-NetFirewallPortFilter { [pscustomobject]@{Protocol='TCP';LocalPort=$script:created.Port} }
function Get-NetFirewallApplicationFilter { [pscustomobject]@{Program=$script:created.Program} }
function Get-NetFirewallAddressFilter { [pscustomobject]@{RemoteAddress=$script:created.RemoteAddress} }
$text=[IO.File]::ReadAllText((Join-Path $source 'Set-EnrollmentFirewallBoundary.ps1')) -replace '(?m)^#Requires.*$',''
foreach($port in @(22,5900)) {
 $script:created=$null
 $program=if($port -eq 22){Join-Path $env:WINDIR 'System32\OpenSSH\sshd.exe'}else{Join-Path $env:ProgramFiles 'TightVNC\tvnserver.exe'}
 & ([scriptblock]::Create($text)) -HubAddress '100.79.63.56' -Program $program -Port $port
 $expected=@('0.0.0.0-100.79.63.55','100.79.63.57-255.255.255.255','::/1','8000::/1')
 if(@(Compare-Object $expected $script:created.RemoteAddress).Count){throw 'Wrong private address boundary'}
 if($script:created.Program -ne $program -or $script:created.Port -ne $port){throw 'Wrong scope'}
}
'PASS: helper syntax and SSH/Remote boundaries; no real machine settings changed.'
