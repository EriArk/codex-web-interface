[CmdletBinding()]
param([string]$NodeCommand=(Get-Command node.exe -ErrorAction Stop).Source,[string]$ProbePath=(Join-Path $PSScriptRoot '../../packages/machines/dist/setupProbe.js'))
$ErrorActionPreference='Stop'
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$directory=Join-Path $env:LOCALAPPDATA 'CodexWeb\project-setup'
$taskName='CodexWebProjectSetup'
$existing=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if($existing -and $existing.State -eq 'Running'){throw 'Project setup is busy. Retry after it finishes.'}
$node=[IO.Path]::GetFullPath($NodeCommand)
if(-not (Test-Path -LiteralPath $node -PathType Leaf) -or $node -match '\\WindowsApps\\'){throw 'Use a stable Node runtime outside the desktop package'}
if(-not (Test-Path -LiteralPath $ProbePath -PathType Leaf)){throw 'Build packages/machines on Linux and provide the compiled setupProbe.js'}
foreach($dir in @($directory,(Join-Path $env:LOCALAPPDATA 'CodexWeb\project-setup-state'))){
 New-Item -ItemType Directory -Path $dir -Force | Out-Null
 $acl=Get-Acl -LiteralPath $dir;$acl.SetAccessRuleProtection($true,$false)
 foreach($rule in @($acl.Access)){$acl.RemoveAccessRuleSpecific($rule)}
 foreach($sid in @($identity.User,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'),[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))}
 [IO.Directory]::SetAccessControl($dir,$acl)
}
Copy-Item -LiteralPath $ProbePath -Destination (Join-Path $directory 'setupProbe.js') -Force
foreach($file in @('ProjectSetupWorker.cjs','Run-ProjectSetup.ps1')){Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination (Join-Path $directory $file) -Force}
[IO.File]::WriteAllText((Join-Path $directory 'package.json'),' {"type":"module"}',[Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $directory 'config.json'),(@{node=$node}|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
$action=New-ScheduledTaskAction -Execute (Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe') -Argument ('-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+(Join-Path $directory 'Run-ProjectSetup.ps1')+'"') -WorkingDirectory $directory
$principal=New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Limited
$settings=New-ScheduledTaskSettingsSet -Hidden -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::FromMinutes(10)) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings -Description 'Fixed project setup: inspect/create/clone/link GitHub repository. Private receipts; no listener or desktop control.' -Force | Out-Null
Write-Output 'Private project setup worker installed.'
