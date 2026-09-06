# Lightweight behavioral checks. Loads only the maintenance function and replaces every OS effect.
param([string]$ControlScript=(Join-Path $PSScriptRoot '../ops/windows/CodexDesktopControl.ps1'))
$ErrorActionPreference='Stop'
$tokens=$null;$parseErrors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile([IO.Path]::GetFullPath($ControlScript),[ref]$tokens,[ref]$parseErrors)
if ($parseErrors.Count) { throw 'PowerShell syntax error' }
$function=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Run-Operation'},$true)
. ([ScriptBlock]::Create($function.Extent.Text))
function Assert($condition,$message) { if (-not $condition) { throw $message } }
function Reset-Test {
    $script:operation=[pscustomobject]@{id='test';kind='restart';state='queued';code='';requestedAt=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()}
    $script:active=0;$script:session=1;$script:stopped=@();$script:started=0;$script:closed=0;$script:failure=$false
    $script:processes=@{
        10=[pscustomobject]@{ProcessId=10;ParentProcessId=1;SessionId=1;CreationDate=10;ExecutablePath='C:\Package\ChatGPT.exe'}
        11=[pscustomobject]@{ProcessId=11;ParentProcessId=10;SessionId=1;CreationDate=11;ExecutablePath='C:\Codex\codex.exe'}
        12=[pscustomobject]@{ProcessId=12;ParentProcessId=90;SessionId=1;CreationDate=12;ExecutablePath='C:\Codex\codex.exe'}
    }
}
function Read-Operation { return $script:operation }
function Complete-Operation($operation,$state,$code) { $operation.state=$state;$operation.code=$code }
function Get-Activity { if ($script:failure) { throw 'DESKTOP_ACTIVITY_UNAVAILABLE' }; return @{active=$script:active} }
function Get-Desktop { return @{exe='C:\Package\ChatGPT.exe';processes=@($script:processes.Values | Where-Object ExecutablePath -EQ 'C:\Package\ChatGPT.exe')} }
function Get-Process {
    param($Id,$ErrorAction)
    if($Id -eq $PID) { return @{SessionId=$script:session} }
    $p=[pscustomobject]@{MainWindowHandle=1}
    $p | Add-Member ScriptMethod CloseMainWindow { $script:closed++;$script:processes.Remove(10); return $true }
    return $p
}
function Get-CimInstance {
    param($ClassName,$Filter)
    if($Filter -eq "Name = 'codex.exe'") { return @($script:processes.Values | Where-Object ExecutablePath -EQ 'C:\Codex\codex.exe') }
    if($Filter -match '^ProcessId = ([0-9]+)$') { return $script:processes[[int]$Matches[1]] }
    throw 'Unexpected process query'
}
function Stop-Process { param($Id,[switch]$Force,$ErrorAction) $script:stopped+=@($Id);$script:processes.Remove([int]$Id) }
function Start-Process {
    param($FilePath,$WorkingDirectory)
    Assert ($FilePath -eq 'C:\Package\ChatGPT.exe') 'Only the installed package can launch'
    $script:started++
    $script:processes[20]=[pscustomobject]@{ProcessId=20;SessionId=1;ExecutablePath='C:\Package\ChatGPT.exe'}
}
function Start-Sleep { param($Milliseconds) }
Reset-Test;Run-Operation
Assert ($operation.code -eq 'DESKTOP_RESTARTED' -and $started -eq 1) 'Idle desktop did not restart'
Assert ($stopped.Count -eq 1 -and $stopped[0] -eq 11) 'Restart touched an unrelated App Server'
Assert ($processes.ContainsKey(12)) 'Companion-owned App Server was stopped'
Reset-Test;$script:active=1;Run-Operation
Assert ($operation.code -eq 'DESKTOP_BUSY' -and $started -eq 0 -and $closed -eq 0 -and $stopped.Count -eq 0) 'Active task was touched'
Reset-Test;$script:failure=$true;Run-Operation
Assert ($operation.code -eq 'DESKTOP_ACTIVITY_UNAVAILABLE' -and $closed -eq 0) 'Unknown activity did not fail closed'
Reset-Test;$script:session=0;Run-Operation
Assert ($operation.code -eq 'DESKTOP_INTERACTIVE_SESSION_REQUIRED' -and $closed -eq 0) 'Session 0 was allowed'
Reset-Test;$operation.requestedAt-=120;Run-Operation
Assert ($operation.code -eq 'DESKTOP_REQUEST_EXPIRED' -and $closed -eq 0) 'Stale request executed'
Reset-Test;$operation.kind='probe';$script:active=1;Run-Operation
Assert ($operation.code -eq 'DESKTOP_INTERACTIVE_PROBE_OK' -and $closed -eq 0 -and $started -eq 0) 'Probe had effects'
Reset-Test;$operation.state='completed';Run-Operation
Assert ($closed -eq 0 -and $started -eq 0) 'Completed operation was replayed'
Reset-Test;$operation.kind='forcerestart';$script:active=5;$script:failure=$true;Run-Operation
Assert ($operation.code -eq 'DESKTOP_RESTARTED' -and $started -eq 1 -and $closed -eq 0) 'Hard restart depended on graceful close or activity observation'
Assert ($stopped.Count -eq 2 -and $stopped -contains 10 -and $stopped -contains 11 -and $processes.ContainsKey(12)) 'Hard restart touched an unrelated App Server'
Reset-Test;$operation.kind='forcerestart';$script:session=0;Run-Operation
Assert ($operation.code -eq 'DESKTOP_INTERACTIVE_SESSION_REQUIRED' -and $stopped.Count -eq 0) 'Hard restart escaped the interactive-session boundary'
Reset-Test;$operation.kind='forcerelease';$script:active=5;$script:failure=$true;Run-Operation
Assert ($operation.code -eq 'DESKTOP_RELEASED' -and $closed -eq 1 -and $started -eq 0) 'Return did not close the desktop without relaunching'
Assert ($stopped.Count -eq 1 -and $stopped[0] -eq 11 -and $processes.ContainsKey(12)) 'Return touched a Companion-owned App Server'
Reset-Test;$operation.kind='forcerelease';$script:session=0;Run-Operation
Assert ($operation.code -eq 'DESKTOP_INTERACTIVE_SESSION_REQUIRED' -and $closed -eq 0 -and $stopped.Count -eq 0) 'Return escaped the interactive-session boundary'
Write-Output '11 desktop maintenance checks passed; all process effects were simulated.'
