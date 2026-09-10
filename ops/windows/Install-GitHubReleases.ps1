[CmdletBinding()]
param([string]$NodeCommand=(Get-Command node.exe -ErrorAction Stop).Source)
$ErrorActionPreference='Stop'
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$directory=Join-Path $env:LOCALAPPDATA 'CodexWeb\github-releases'
$taskName='CodexWebGitHubReleases'
$existing=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if($existing -and $existing.State -eq 'Running'){throw 'GitHub release reader is busy. Retry installation after it finishes.'}
$node=[IO.Path]::GetFullPath($NodeCommand)
$gh=(Get-Command gh.exe -ErrorAction Stop).Source
if(-not (Test-Path -LiteralPath $node -PathType Leaf)){throw 'Node runtime unavailable'}
if($node -match '\\WindowsApps\\'){throw 'Use a stable Node runtime outside the desktop app package'}
New-Item -ItemType Directory -Path $directory -Force | Out-Null
$acl=Get-Acl -LiteralPath $directory
$acl.SetAccessRuleProtection($true,$false)
foreach($rule in @($acl.Access)){$acl.RemoveAccessRuleSpecific($rule)}
foreach($sid in @($identity.User,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'),[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))){
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
}
[IO.Directory]::SetAccessControl($directory,$acl)
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'GitHubReleases.cjs') -Destination (Join-Path $directory 'GitHubReleases.cjs') -Force
[IO.File]::WriteAllText((Join-Path $directory 'config.json'),(@{gh=$gh;node=$node;userSid=$identity.User.Value}|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Run-GitHubReleases.ps1') -Destination (Join-Path $directory 'Run-GitHubReleases.ps1') -Force
$action=New-ScheduledTaskAction -Execute (Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe') -Argument ('-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+(Join-Path $directory 'Run-GitHubReleases.ps1')+'"') -WorkingDirectory $directory
$principal=New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Limited
$settings=New-ScheduledTaskSettingsSet -Hidden -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::FromSeconds(40)) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings -Description 'Read-only GitHub releases with existing user-session login. No network listener or desktop control.' -Force | Out-Null
Write-Output 'Private GitHub release reader installed. Existing applications were not restarted.'
