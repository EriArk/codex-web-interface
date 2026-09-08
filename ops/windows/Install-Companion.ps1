#Requires -RunAsAdministrator
[CmdletBinding()]
param(
    [string]$CodexCommand,
    [Parameter(Mandatory=$true)][string[]]$WorkingDirectories
)
$ErrorActionPreference = 'Stop'
$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptDirectory 'Copy-CompanionRuntime.ps1')
if (-not $CodexCommand) { $CodexCommand = (Get-Command codex.exe -ErrorAction Stop).Source }
$targetDirectory = Join-Path $env:LOCALAPPDATA 'CodexWeb\companion'
$taskName = 'CodexWebCompanion'
$existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existingTask -and $existingTask.State -eq 'Running') { throw 'Stop the idle CodexWebCompanion task before reinstalling it.' }
New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null
$CodexCommand = Copy-CompanionRuntime -CodexCommand $CodexCommand -TargetDirectory $targetDirectory
$source = Join-Path $scriptDirectory 'companion\CodexWebBridge.cs'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$client = Join-Path $targetDirectory 'CodexWebBridge.exe'
$server = Join-Path $targetDirectory 'CodexWebCompanion.exe'
& $compiler /nologo /target:exe /platform:x64 /r:System.Web.Extensions.dll "/out:$client" $source
if ($LASTEXITCODE -ne 0) { throw 'Companion client compilation failed.' }
& $compiler /nologo /target:winexe /platform:x64 /r:System.Web.Extensions.dll "/out:$server" $source
if ($LASTEXITCODE -ne 0) { throw 'Companion compilation failed.' }
$configPath = Join-Path $targetDirectory 'config.json'
$config = @{codexCommand=$CodexCommand;workingDirectories=@($WorkingDirectories)} | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText($configPath,$config,[System.Text.UTF8Encoding]::new($false))
$userIdentity=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$action=New-ScheduledTaskAction -Execute $server -Argument ('--server "' + $configPath + '"') -WorkingDirectory $targetDirectory
$principal=New-ScheduledTaskPrincipal -UserId $userIdentity -LogonType Interactive -RunLevel Limited
$trigger=New-ScheduledTaskTrigger -AtLogOn -User $userIdentity
$settings=New-ScheduledTaskSettingsSet -Hidden -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval ([TimeSpan]::FromMinutes(1)) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Trigger $trigger -Settings $settings -Description 'Local named-pipe Codex launcher for the private Linux Hub; no network listener.' -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
& $client --probe
if ($LASTEXITCODE -ne 0) { throw 'Companion did not become ready.' }
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName,State
