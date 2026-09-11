[CmdletBinding()]
param([string]$NodeCommand=(Get-Command node.exe -ErrorAction Stop).Source)
$ErrorActionPreference='Stop'
$directory=Join-Path $env:LOCALAPPDATA 'CodexWeb\gui-preview'
$taskName='CodexWebGuiPreview'
$existing=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if($existing -and $existing.State -eq 'Running'){throw 'Preview helper is busy. Close its previews before updating.'}
$node=[IO.Path]::GetFullPath($NodeCommand)
if(-not(Test-Path -LiteralPath $node -PathType Leaf) -or $node -match '\\WindowsApps\\'){throw 'Use a stable Node runtime'}
New-Item -ItemType Directory -Path $directory -Force|Out-Null
$identity=[Security.Principal.WindowsIdentity]::GetCurrent();$acl=Get-Acl -LiteralPath $directory;$acl.SetAccessRuleProtection($true,$false)
foreach($rule in @($acl.Access)){$acl.RemoveAccessRuleSpecific($rule)}
foreach($sid in @($identity.User,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'),[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))}
[IO.Directory]::SetAccessControl($directory,$acl)
foreach($name in @('GuiPreviewWorker.cjs','NativePreview.ps1','PreviewWindow.cs','Run-GuiPreview.ps1')){Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $directory $name) -Force}
[IO.File]::WriteAllText((Join-Path $directory 'config.json'),(@{node=$node}|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
$allowlist=Join-Path $directory 'actions.json';if(-not(Test-Path -LiteralPath $allowlist)){[IO.File]::WriteAllText($allowlist,'[]',[Text.UTF8Encoding]::new($false))}
$action=New-ScheduledTaskAction -Execute (Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe') -Argument ('-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+(Join-Path $directory 'Run-GuiPreview.ps1')+'"') -WorkingDirectory $directory
$principal=New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Limited
$settings=New-ScheduledTaskSettingsSet -Hidden -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::FromMinutes(130)) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings -Description 'Configured project window previews; private mailbox, owned process jobs, no network listener.' -Force|Out-Null
Write-Output 'Private GUI preview helper installed; existing action allowlist preserved.'
