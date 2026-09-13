#Requires -Version 5.1
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
trap {
    Add-Type -AssemblyName System.Windows.Forms
    [void][Windows.Forms.MessageBox]::Show($_.Exception.Message, 'CodexWeb — настройка приостановлена', 'OK', 'Warning')
    exit 1
}
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $PSCommandPath + '"')) -Verb RunAs -WindowStyle Hidden
    return
}
# This file is generated for one connection. It contains a short-lived pairing token.
# It contains no account password, Codex/GitHub credentials or private SSH key.
$encoded = '__ENROLLMENT_PAYLOAD__'
$stream = [IO.MemoryStream]::new([Convert]::FromBase64String($encoded))
$gzip = [IO.Compression.GZipStream]::new($stream, [IO.Compression.CompressionMode]::Decompress)
$reader = [IO.StreamReader]::new($gzip, [Text.Encoding]::UTF8)
try { $payload = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose(); $gzip.Dispose(); $stream.Dispose() }
if ($payload.descriptor.version -ne 1 -or $payload.descriptor.id -notmatch '^[a-f0-9-]{36}$') { throw 'Invalid connection package.' }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$directory = Join-Path $env:LOCALAPPDATA ('CodexWeb\enrollment\' + $payload.descriptor.id)
$boundary = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'CodexWeb\enrollment')).TrimEnd('\') + '\'
if (-not [IO.Path]::GetFullPath($directory).StartsWith($boundary, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid package directory.' }
$ancestor = $directory
while ($ancestor) {
    if ((Test-Path -LiteralPath $ancestor) -and ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Connection package directory contains a link.' }
    $ancestor = Split-Path -Parent $ancestor
}
New-Item -ItemType Directory -Path $directory -Force | Out-Null
$acl = [Security.AccessControl.DirectorySecurity]::new()
$acl.SetAccessRuleProtection($true, $false)
foreach ($sid in @($identity.User, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'), [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))) {
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
}
Set-Acl -LiteralPath $directory -AclObject $acl
foreach ($file in $payload.files) {
    if ($file.name -notmatch '^[A-Za-z0-9_-]+(?:/[A-Za-z0-9_-]+)*\.(ps1|cjs|js|cs)$') { throw 'Unexpected package file.' }
    $path = [IO.Path]::GetFullPath((Join-Path $directory $file.name))
    if (-not $path.StartsWith($directory.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected package path.' }
    $check = $path
    while ($check -and $check -ne $directory) {
        if ((Test-Path -LiteralPath $check) -and ((Get-Item -LiteralPath $check -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Package file contains a link.' }
        $check = Split-Path -Parent $check
    }
    New-Item -ItemType Directory -Path (Split-Path -Parent $path) -Force | Out-Null
    [IO.File]::WriteAllBytes($path, [Convert]::FromBase64String($file.data))
}
$descriptor = Join-Path $directory 'connection.json'
if ((Test-Path -LiteralPath $descriptor) -and ((Get-Item -LiteralPath $descriptor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Connection descriptor contains a link.' }
[IO.File]::WriteAllText($descriptor, ($payload.descriptor | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
. (Join-Path $directory 'EnrollmentUi.ps1')
New-CwWindow
try {
    & (Join-Path $directory 'Enroll-Computer.ps1') -ConnectionFile $descriptor
    [void](Confirm-Cw 'Компьютер подготовлен. Вернитесь на сайт: осталось подтверждение администратора и активация подключения.')
} catch {
    [void][Windows.Forms.MessageBox]::Show($script:CwWindow, $_.Exception.Message, 'CodexWeb — настройка приостановлена', 'OK', 'Warning')
} finally { $script:CwWindow.Dispose() }
