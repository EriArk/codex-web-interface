#Requires -Version 5.1
[CmdletBinding()]
param([switch]$RepairExistingServices)
$ErrorActionPreference='Stop'
try {
    $script=Join-Path $PSScriptRoot 'Test-CodexWebConnection.ps1'
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
    $admin=([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if ($RepairExistingServices -and -not $admin) {
        # The recipient needs the interactive console for findings and the report location.
        Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -Verb RunAs -WindowStyle Normal -Wait -ArgumentList @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+$script+'"'),'-RepairExistingServices')
    } else { & $script -RepairExistingServices:$RepairExistingServices }
} catch {
    Write-Host 'Запуск отменён или Windows не разрешила повышение прав. Можно выполнить 01-Diagnose.cmd без повышения прав.' -ForegroundColor Yellow
    [void](Read-Host 'Нажми Enter, чтобы закрыть окно')
}
