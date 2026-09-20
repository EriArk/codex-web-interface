#Requires -Version 5.1
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
try {
    $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+$PSCommandPath+'"')) -Verb RunAs -WindowStyle Hidden
        return
    }
    $root = Join-Path $env:LOCALAPPDATA 'CodexWeb\enrollment'
    $folders = @(Get-ChildItem -LiteralPath $root -Directory | Where-Object { $_.Name -match '^[a-f0-9-]{36}$' -and (Test-Path -LiteralPath (Join-Path $_.FullName 'connection.json')) })
    if ($folders.Count -ne 1) { throw 'Нужно одно сохранённое подключение. Отправьте администратору количество найденных подключений: ' + $folders.Count }
    $directory = $folders[0].FullName
    $cursor = $directory
    while ($cursor) {
        if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Папка подключения содержит ссылку.' }
        $cursor = Split-Path -Parent $cursor
    }
    $mutex = [Threading.Mutex]::new($false, ('Local\CodexWebEnrollment-' + $folders[0].Name))
    try { $acquired = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $acquired=$true }
    if (-not $acquired) { throw 'Закройте прежний мастер подключения и запустите этот файл снова.' }
    foreach ($name in @('Finish-Enrollment.ps1','Set-EnrollmentFirewallBoundary.ps1','Pair-ComputerSsh.ps1','Install-EnrolledRemote.ps1','Install-RemoteDesktop.ps1')) {
        $target = Join-Path $directory $name
        if ((Test-Path -LiteralPath $target) -and ((Get-Item -LiteralPath $target -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Файл подключения содержит ссылку.' }
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination $target -Force
    }
    . (Join-Path $directory 'Finish-Enrollment.ps1')
} catch {
    [void][Windows.Forms.MessageBox]::Show($_.Exception.Message, 'CodexWeb — завершение подключения', 'OK', 'Warning')
} finally {
    if ($mutex) { if ($acquired) { $mutex.ReleaseMutex() }; $mutex.Dispose() }
}
