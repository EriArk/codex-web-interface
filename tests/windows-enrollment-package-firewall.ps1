$ErrorActionPreference='Stop'
function Get-NetFirewallRule { [pscustomobject]@{DisplayName='Work or school account'} }
function Get-NetFirewallPortFilter { [pscustomobject]@{Protocol='TCP';LocalPort='Any'} }
function Get-NetFirewallApplicationFilter { [pscustomobject]@{Program='Any';Package=$script:package} }
function Get-NetFirewallServiceFilter { [pscustomobject]@{Service='Any'} }
function Get-NetFirewallAddressFilter { [pscustomobject]@{RemoteAddress='Any'} }
$Connection=@{hubAddress='100.79.63.56'}
$sshBin='C:\Windows\System32\OpenSSH'
$program='C:\Program Files\TightVNC\tvnserver.exe'
foreach($file in @('Pair-ComputerSsh.ps1','Install-EnrolledRemote.ps1')) {
 $ast=[Management.Automation.Language.Parser]::ParseInput([IO.File]::ReadAllText((Join-Path (Join-Path (Split-Path -Parent $PSScriptRoot) 'ops\windows') $file)),[ref]$null,[ref]$null)
 foreach($f in $ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst]},$true)){. ([scriptblock]::Create($f.Extent.Text))}
 $loop=$ast.Find({param($n) $n -is [Management.Automation.Language.ForEachStatementAst] -and $n.Variable.VariablePath.UserPath -eq 'rule'},$true)
 if (-not $loop) { throw 'Firewall scan loop missing.' }
 foreach($p in @('S-1-15-2-12345','Any','')){
  $script:package=$p
  $caught=$false
  try{& ([scriptblock]::Create($loop.Extent.Text))}catch{$caught=$true}
  if($caught -ne ($p -ne 'S-1-15-2-12345')){throw "Wrong classification: $file / $p"}
 }
}
'PASS: actual SSH and VNC rule loops skip packaged apps and still reject unrestricted native rules.'


