#Requires -RunAsAdministrator
[CmdletBinding()]
param(
    [string]$NodeCommand=(Get-Command node.exe -ErrorAction Stop).Source,
    [string]$CodexHome=(Join-Path $env:USERPROFILE '.codex')
)
$ErrorActionPreference='Stop'
$taskName='CodexWebDesktopRestart'
$existing=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing -and $existing.State -eq 'Running') { throw 'Desktop maintenance is running; install after it completes.' }
$package=@(Get-AppxPackage -Name OpenAI.Codex)
if ($package.Count -ne 1 -or -not (Test-Path -LiteralPath (Join-Path $package[0].InstallLocation 'app\ChatGPT.exe'))) { throw 'The supported OpenAI.Codex desktop package is not installed for this user.' }
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$targetDirectory=Join-Path $env:LOCALAPPDATA 'CodexWeb\desktop-control'
New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null
$acl=New-Object Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true,$false)
foreach ($sid in @($identity.User,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'),[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))) {
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
}
Set-Acl -LiteralPath $targetDirectory -AclObject $acl
foreach ($file in @('CodexDesktopControl.ps1','desktop-activity.cjs','DesktopWindow.ps1')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination (Join-Path $targetDirectory $file) -Force
}
$config=@{packageFamily=$package[0].PackageFamilyName;userSid=$identity.User.Value;nodeCommand=[IO.Path]::GetFullPath($NodeCommand);codexHome=[IO.Path]::GetFullPath($CodexHome)}
[IO.File]::WriteAllText((Join-Path $targetDirectory 'config.json'),($config | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
$script=Join-Path $targetDirectory 'CodexDesktopControl.ps1'
$action=New-ScheduledTaskAction -Execute (Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe') -Argument ('-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+$script+'" -Action Run') -WorkingDirectory $targetDirectory
# Highest is needed to close Codex when the owner launched it as administrator.
# The task exposes one fixed package-maintenance action, no command or PID arguments.
$principal=New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Highest
$settings=New-ScheduledTaskSettingsSet -Hidden -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::FromMinutes(2)) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings -Description 'Explicit Codex desktop restart from the private Hub; no automatic trigger, no network listener.' -Force | Out-Null
Write-Output 'Desktop restart control installed. Codex and Companion were not restarted.'
