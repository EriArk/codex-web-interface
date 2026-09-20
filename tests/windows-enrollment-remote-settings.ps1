$ErrorActionPreference='Stop'
$path=Join-Path (Split-Path -Parent $PSScriptRoot) 'ops\windows\Install-EnrolledRemote.ps1'
$ast=[Management.Automation.Language.Parser]::ParseInput([IO.File]::ReadAllText($path),[ref]$null,[ref]$null)
$f=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Get-CwRemoteEffectiveSettings'},$true)
. ([scriptblock]::Create($f.Extent.Text))
$actual=Get-CwRemoteEffectiveSettings ([pscustomobject]@{AcceptHttpConnections=0;AcceptRfbConnections=1;UseVncAuthentication=1})
if($actual.RfbPort -ne 5900 -or $actual.AcceptHttpConnections -ne 0 -or $actual.UseVncAuthentication -ne 1){throw 'Fresh MSI defaults rejected'}
$actual=Get-CwRemoteEffectiveSettings ([pscustomobject]@{RfbPort=5999;AcceptRfbConnections=0;UseVncAuthentication=0})
if($actual.RfbPort -ne 5999 -or $actual.AcceptRfbConnections -ne 0 -or $actual.UseVncAuthentication -ne 0 -or $actual.AcceptHttpConnections -ne 1){throw 'Explicit settings or unsafe HTTP default lost'}
'PASS: native TightVNC missing defaults and explicit settings preserved.'
