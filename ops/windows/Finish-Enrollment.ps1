#Requires -Version 5.1
#Requires -RunAsAdministrator
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'EnrollmentUi.ps1')
. (Join-Path $PSScriptRoot 'EnrollmentState.ps1')
New-CwWindow
$script:CwWindow.Text = 'CodexWeb — завершение подключения · v3'
$diagnosticPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'CodexWeb-connection-diagnostic.txt'
try {
    $connection = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'connection.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $base = [Uri]$connection.baseUrl
    if ($base.Scheme -ne 'https' -or $base.UserInfo -or $base.Query -or $base.Fragment -or $base.AbsolutePath -ne '/' -or $connection.token -notmatch '^[A-Za-z0-9_-]{43}$') { throw 'Invalid saved connection.' }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $interactive = @(Get-CimInstance Win32_Process -Filter "Name='explorer.exe'" | ForEach-Object { (Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid -ErrorAction SilentlyContinue).Sid })
    if ($identity.User.Value -notin $interactive) { throw 'Запустите файл от своего пользователя Windows, как прежний мастер.' }
    $machineGuid = (Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Cryptography').MachineGuid.ToLowerInvariant()
    $step = Initialize-CwEnrollmentState (Join-Path $PSScriptRoot 'setup-state.json') $connection $identity.User.Value $machineGuid $env:USERPROFILE
    if ($step -lt 4) { throw 'Сначала завершите установку программ в основном мастере до шага 4.' }
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $savedReport = Join-Path $PSScriptRoot 'submitted-report.json'
    if (Test-Path -LiteralPath $savedReport) {
        $json = [IO.File]::ReadAllText($savedReport)
        $report = $json | ConvertFrom-Json
        Assert-CwReportIdentity $report $identity.User.Value $machineGuid $env:USERPROFILE
    } else {
        if ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -ge $connection.expires) { throw 'Срок пакета подключения истёк. Получите новый пакет на сайте.' }
        $roots = @(Get-Content -LiteralPath (Join-Path $PSScriptRoot 'selected-roots.json') -Raw -Encoding UTF8 | ConvertFrom-Json)
        if (-not $roots.Count) { throw 'Не найдена сохранённая папка проектов.' }
        $address = Get-CwTailnetAddress (Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe')
        if (-not $address) { throw 'Войдите в Tailscale и повторите запуск.' }
        if (-not (Test-Path -LiteralPath (Join-Path $env:WINDIR 'System32\OpenSSH\sshd.exe'))) { throw 'OpenSSH ещё не установлен. Дождитесь завершения установки Windows.' }
        $companion = Join-Path $env:LOCALAPPDATA 'CodexWeb\companion\CodexWebBridge.exe'
        & $companion --probe | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Companion не ответил на проверку готовности.' }
        $node = Get-Command node.exe -ErrorAction Stop
        if (-not (Confirm-Cw ('Завершить подключение к ' + $base.Host + '? Программы не переустанавливаются. Для SSH и выбранного Remote будут добавлены правила, блокирующие вход со всех адресов, кроме Hub. Системные правила других приложений сохранятся.'))) { return }
        Write-CwStep 4 'Настраиваем приватное подключение SSH'
        & (Join-Path $PSScriptRoot 'Pair-ComputerSsh.ps1') -Connection $connection -PrivateBoundary
        $hostKey = ((Get-Content -LiteralPath (Join-Path $env:ProgramData 'ssh\ssh_host_ed25519_key.pub') -Raw).Trim() -split ' ')[0..1] -join ' '
        Show-CwFingerprint $hostKey
        $remote = & (Join-Path $PSScriptRoot 'Install-EnrolledRemote.ps1') -Connection $connection -Window $script:CwWindow -PrivateBoundary
        $report = @{version=1; address=$address; hostKey=$hostKey; machineGuid=$machineGuid; sid=$identity.User.Value; username=$identity.Name.Split('\')[-1]; profile=$env:USERPROFILE; roots=@($roots); readiness=@{companion=$true; codex=$true; node=$true; git=[bool](Get-Command git.exe -ErrorAction SilentlyContinue); github=[bool](Get-Command gh.exe -ErrorAction SilentlyContinue); desktop=(@(Get-AppxPackage -Name OpenAI.Codex).Count -eq 1); remote=[bool]$remote}}
        if ($remote) { $report.remote=$remote }
        $json = $report | ConvertTo-Json -Depth 6 -Compress
        [IO.File]::WriteAllText($savedReport, $json, [Text.UTF8Encoding]::new($false))
    }
    Write-CwStep 5 'Отправляем готовое подключение на сервер'
    try {
        Invoke-RestMethod -Method Post -Uri ($base.AbsoluteUri.TrimEnd('/') + '/api/machine-enrollment/report') -Headers @{Authorization=('Bearer ' + $connection.token)} -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($json)) -TimeoutSec 30 | Out-Null
    } catch { throw 'Сервер пока не подтвердил подключение. Отчёт сохранён; можно повторить запуск этого файла.' }
    [void](Confirm-Cw 'Подключение подготовлено и отправлено. Откройте CodexWeb: осталось подтверждение администратора и активация компьютера.')
    Start-Process ($base.AbsoluteUri + '#setup')
} catch {
    # Never serialize the descriptor, report, native accounts or raw invocation values.
    $message = $_.Exception.Message
    if ($connection -and $connection.token) { $message = $message.Replace([string]$connection.token, '[redacted]') }
    $details = @('CodexWeb finish-connection', ('Time: ' + [DateTime]::Now.ToString('s')), ('Error: ' + $message))
    try {
        foreach ($rule in @(Get-NetFirewallRule -Enabled True -Direction Inbound -Action Allow)) {
            $port = $rule | Get-NetFirewallPortFilter
            if ([string]$port.LocalPort -notin @('Any','22','5900')) { continue }
            $app = $rule | Get-NetFirewallApplicationFilter
            $service = $rule | Get-NetFirewallServiceFilter
            $details += (@{name=$rule.DisplayName; program=$app.Program; package=$app.Package; service=$service.Service; ports=$port.LocalPort} | ConvertTo-Json -Compress)
        }
    } catch { $details += 'Firewall diagnostic unavailable.' }
    try { [IO.File]::WriteAllLines($diagnosticPath, $details, [Text.UTF8Encoding]::new($true)) } catch { }
    [void][Windows.Forms.MessageBox]::Show($script:CwWindow, ($message + "`r`n`r`nДиагностика: " + $diagnosticPath), 'CodexWeb — завершение подключения', 'OK', 'Warning')
} finally { $script:CwWindow.Dispose() }
