#Requires -Version 5.1
#Requires -RunAsAdministrator
[CmdletBinding()]
param([Parameter(Mandatory=$true)]$Connection, [Parameter(Mandatory=$true)]$Window)
$ErrorActionPreference = 'Stop'
function Test-CwRemotePort($filter) {
    if ([string]$filter.Protocol -notin @('TCP', '6', 'Any', '256')) { return $false }
    foreach ($port in @($filter.LocalPort)) {
        if ([string]$port -in @('Any', '5900')) { return $true }
        if ([string]$port -match '^(\d+)-(\d+)$' -and [int]$Matches[1] -le 5900 -and [int]$Matches[2] -ge 5900) { return $true }
    }
    return $false
}
function Test-CwRemoteRule($rule, $port, $address, [string]$hub) {
    return ([string]$rule.Enabled -eq 'True' -and [string]$rule.Direction -eq 'Inbound' -and
        [string]$rule.Action -eq 'Allow' -and [string]$rule.Profile -eq 'Any' -and
        [string]$port.Protocol -in @('TCP', '6') -and @($port.LocalPort).Count -eq 1 -and
        [string]$port.LocalPort -eq '5900' -and @($address.RemoteAddress).Count -eq 1 -and
        [string]$address.RemoteAddress -in @($hub, ($hub + '/32')))
}
if ($Connection.hubAddress -notmatch '^100\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$' -or [int]$Matches[1] -lt 64 -or [int]$Matches[1] -gt 127 -or [int]$Matches[2] -gt 255 -or [int]$Matches[3] -gt 255) { throw 'Expected the private Hub Tailscale address.' }
if (-not [Environment]::Is64BitOperatingSystem) { Write-Host 'Remote: automatic setup requires 64-bit Windows.'; return $null }
$directory = Join-Path $env:LOCALAPPDATA 'CodexWeb\remote'
$statePath = Join-Path $directory 'enrollment.json'
$ancestor = $statePath
while ($ancestor) {
    if ((Test-Path -LiteralPath $ancestor) -and ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Remote configuration contains a link.' }
    $ancestor = Split-Path -Parent $ancestor
}
$service = Get-Service -Name tvnserver -ErrorAction SilentlyContinue
if ($service -and -not (Test-Path -LiteralPath $statePath)) {
    [void](Confirm-Cw 'На ПК уже есть TightVNC, который этот мастер не настраивал. Сохраняем его как есть. Codex и терминал подключатся; существующий Remote можно будет подключить после отдельной проверки.')
    return $null
}
if (-not (Test-Path -LiteralPath $statePath)) {
    $choice = [Windows.Forms.MessageBox]::Show($Window, 'Подключить рабочий стол к кнопке Remote? Мастер установит TightVNC Server. Доступ будет только через приватную сеть от Hub и только из вашего аккаунта CodexWeb. Пароль Windows не нужен. «Нет» — продолжить без Remote.', 'Ваш удалённый рабочий стол', 'YesNo', 'Question')
    if ($choice -ne 'Yes') { return $null }
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $acl = [Security.AccessControl.DirectorySecurity]::new(); $acl.SetAccessRuleProtection($true, $false)
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    foreach ($sid in @($identity.User, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'), [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
    }
    Set-Acl -LiteralPath $directory -AclObject $acl
    $random = [Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $bytes = [byte[]]::new(6); $random.GetBytes($bytes)
        $password = [Convert]::ToBase64String($bytes).Replace('+', '-').Replace('/', '_')
        $controlBytes = [byte[]]::new(16); $random.GetBytes($controlBytes)
        $controlPassword = [BitConverter]::ToString($controlBytes).Replace('-', '').ToLowerInvariant()
    } finally { $random.Dispose() }
    $state = @{ version=1; sid=$identity.User.Value; hubAddress=$Connection.hubAddress; password=$password; controlPassword=$controlPassword }
    [IO.File]::WriteAllText($statePath, ($state | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
}
$state = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($state.version -ne 1 -or $state.sid -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value -or $state.hubAddress -ne $Connection.hubAddress -or $state.password -notmatch '^[A-Za-z0-9_-]{8}$' -or $state.controlPassword -notmatch '^[a-f0-9]{32}$') { throw 'Existing Remote ownership/settings differ. No credentials were replaced.' }
$program = Join-Path $env:ProgramFiles 'TightVNC\tvnserver.exe'
# Validate effective firewall before starting a newly installed network service. Unrelated rules stay intact.
foreach ($profile in @(Get-NetFirewallProfile -PolicyStore ActiveStore)) {
    if ([string]$profile.Enabled -ne 'True' -or [string]$profile.DefaultInboundAction -ne 'Block') { throw 'Для приватного Remote нужен включённый брандмауэр Windows с блокировкой входящих подключений.' }
}
foreach ($rule in @(Get-NetFirewallRule -PolicyStore ActiveStore -Enabled True -Direction Inbound -Action Allow)) {
    if (-not (Test-CwRemotePort ($rule | Get-NetFirewallPortFilter))) { continue }
    $application = $rule | Get-NetFirewallApplicationFilter; $serviceFilter = $rule | Get-NetFirewallServiceFilter
    # Package-scoped AppContainer rules cannot grant access to the native VNC service.
    if ([string]$application.Package -notin @('', 'Any')) { continue }
    $programPath = [Environment]::ExpandEnvironmentVariables([string]$application.Program)
    if ($programPath -notin @('Any', $program) -or [string]$serviceFilter.Service -notin @('Any', 'tvnserver')) { continue }
    $addresses = @(($rule | Get-NetFirewallAddressFilter).RemoteAddress)
    if (-not $addresses.Count -or @($addresses | Where-Object { $_ -notin @($Connection.hubAddress, ($Connection.hubAddress + '/32')) }).Count) {
        throw ('Remote: правило «' + $rule.DisplayName + '» открывает рабочий стол не только для Hub. Ограничьте его приватным адресом Hub и повторите мастер. Правило не изменялось.')
    }
}
$ruleName = 'CodexWeb-Hub-VNC'
$ownRule = Get-NetFirewallRule -PolicyStore ActiveStore -Name $ruleName -ErrorAction SilentlyContinue
if (-not $ownRule) {
    New-NetFirewallRule -Name $ruleName -DisplayName 'Codex Web: VNC from private Hub only' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 5900 -RemoteAddress $Connection.hubAddress -Profile Any -Program $program | Out-Null
    $ownRule = Get-NetFirewallRule -PolicyStore ActiveStore -Name $ruleName
}
if (@($ownRule).Count -ne 1 -or -not (Test-CwRemoteRule $ownRule ($ownRule | Get-NetFirewallPortFilter) ($ownRule | Get-NetFirewallAddressFilter) $Connection.hubAddress)) {
    throw 'Remote: существующее правило CodexWeb-Hub-VNC отключено или отличается. Проверьте его на этом ПК; чужие правила мастер не меняет.'
}
if (-not $service) {
    $installer = Join-Path $directory 'tightvnc-2.8.88-gpl-setup-64bit.msi'
    if ((Test-Path -LiteralPath $installer) -and ((Get-Item -LiteralPath $installer -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Remote installer contains a link.' }
    if ((Test-Path -LiteralPath $installer) -and (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash -ne 'FA86D817AC29C5FFE1E8E7095E738D9BA5CA28AA62304AC234580916622A8CA2') { Remove-Item -LiteralPath $installer }
    if (-not (Test-Path -LiteralPath $installer)) {
        $download = [Net.WebClient]::new()
        try {
            $task = $download.DownloadFileTaskAsync([Uri]'https://www.tightvnc.com/download/2.8.88/tightvnc-2.8.88-gpl-setup-64bit.msi', $installer)
            $started = [DateTime]::UtcNow
            while (-not $task.IsCompleted) {
                [Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 100
                if ($Window.IsDisposed -or ([DateTime]::UtcNow - $started).TotalSeconds -ge 90) { $download.CancelAsync(); throw 'Загрузка Remote прервана. Повторите запуск мастера.' }
            }
            $task.GetAwaiter().GetResult()
        } finally { $download.Dispose() }
    }
    if ((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash -ne 'FA86D817AC29C5FFE1E8E7095E738D9BA5CA28AA62304AC234580916622A8CA2') { throw 'Remote installer checksum differs. The downloaded file was not run.' }
    $signature = Get-AuthenticodeSignature -LiteralPath $installer
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'CN=OOO GlavSoft,') { throw 'Remote installer signature is not trusted.' }
    $secrets = Join-Path $directory 'install.env'
    if ((Test-Path -LiteralPath $secrets) -and ((Get-Item -LiteralPath $secrets -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Remote settings contain a link.' }
    [IO.File]::WriteAllText($secrets, ('REMOTE_MAIN_WINDOWS_PASSWORD=' + $state.password + "`nREMOTE_MAIN_WINDOWS_CONTROL_PASSWORD=" + $state.controlPassword + "`n"), [Text.UTF8Encoding]::new($false))
    try { & (Join-Path $PSScriptRoot 'Install-RemoteDesktop.ps1') -HubAddress $Connection.hubAddress -Installer $installer -SecretFile $secrets | Out-Null }
    finally { [IO.File]::WriteAllText($secrets, '') }
}
$signature = Get-AuthenticodeSignature -LiteralPath $program
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'CN=OOO GlavSoft,') { throw 'Existing Remote executable is not trusted.' }
$serviceInfo = Get-CimInstance Win32_Service -Filter "Name='tvnserver'"
if ($serviceInfo.PathName -notmatch ('^"?' + [Regex]::Escape($program) + '"?\s+-service$')) { throw 'Remote service command changed. No service was restarted.' }
$settings = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\TightVNC\Server'
if ($settings.RfbPort -ne 5900 -or $settings.AcceptRfbConnections -ne 1 -or $settings.UseVncAuthentication -ne 1 -or $settings.AcceptHttpConnections -ne 0) { throw 'Remote security settings differ. Review TightVNC settings on this PC.' }
if ((Get-Service tvnserver).Status -ne 'Running') { Start-Service tvnserver }
return @{provider='vnc'; port=5900; password=[string]$state.password}
