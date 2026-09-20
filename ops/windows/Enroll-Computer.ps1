#Requires -Version 5.1
#Requires -RunAsAdministrator
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$ConnectionFile)
$ErrorActionPreference = 'Stop'
$connection = Get-Content -LiteralPath $ConnectionFile -Raw -Encoding UTF8 | ConvertFrom-Json
$base = [Uri]$connection.baseUrl
if ($base.Scheme -ne 'https' -or $base.UserInfo -or $base.Query -or $base.Fragment -or $base.AbsolutePath -ne '/') { throw 'Expected the private CodexWeb HTTPS address.' }
if ($connection.token -notmatch '^[A-Za-z0-9_-]{43}$' -or $connection.id -notmatch '^[a-f0-9-]{36}$') { throw 'Invalid connection package.' }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$interactiveSids = @(Get-CimInstance Win32_Process -Filter "Name='explorer.exe'" | ForEach-Object { (Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid -ErrorAction SilentlyContinue).Sid })
if ($identity.User.Value -notin $interactiveSids) { throw 'Run this file as administrator from your own logged-in Windows account. Do not use another administrator account.' }
$headers = @{ Authorization = 'Bearer ' + $connection.token }
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$savedReport = Join-Path $PSScriptRoot 'submitted-report.json'
$machineGuid = (Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Cryptography').MachineGuid.ToLowerInvariant()
. (Join-Path $PSScriptRoot 'EnrollmentState.ps1')
$lastStep = Initialize-CwEnrollmentState (Join-Path $PSScriptRoot 'setup-state.json') $connection $identity.User.Value $machineGuid $env:USERPROFILE
if ($lastStep -gt 0) { $script:CwLog.AppendText("Продолжаем настройку после шага $lastStep из 5. Готовые программы и выбранная папка сохранятся.`r`n`r`n") }
function Submit-Report([string]$json) {
    try {
        Invoke-RestMethod -Method Post -Uri ($base.AbsoluteUri.TrimEnd('/') + '/api/machine-enrollment/report') -Headers $headers -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($json)) -TimeoutSec 30 | Out-Null
    } catch {
        $status = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
        if ($status -in @(401, 403, 404)) { throw 'Сервер не принял пакет: он истёк, отозван или доступ к аккаунту отключён. Проверьте карточку подключения на сайте. Настройки ПК сохранены.' }
        if ($status -eq 409) { throw 'Параметры этого подключения отличаются от уже отправленных. Проверьте его карточку на сайте. Настройки ПК сохранены.' }
        throw 'Не удалось подтвердить подготовку на сервере. Настройки и отчёт сохранены. Проверьте интернет и откройте тот же Connect.cmd ещё раз.'
    }
}
if (Test-Path -LiteralPath $savedReport) {
    # A lost HTTP acknowledgement is reconciled with the exact same report, never a new identity.
    $saved = [IO.File]::ReadAllText($savedReport) | ConvertFrom-Json
    Assert-CwReportIdentity $saved $identity.User.Value $machineGuid $env:USERPROFILE
    Submit-Report ([IO.File]::ReadAllText($savedReport))
    Show-CwFingerprint (([IO.File]::ReadAllText($savedReport) | ConvertFrom-Json).hostKey)
    Write-Host 'The same connection report was confirmed. Return to CodexWeb for administrator approval.'
    return
}
if ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -ge $connection.expires) { throw 'The one-day connection package expired. Download a new one in CodexWeb.' }
if (-not (Confirm-Cw ('Подключаем ' + $identity.Name + ' к ' + $base.Host + '. Мастер установит недостающие Tailscale, Node.js, Git, GitHub CLI, приложение Codex и приватные компоненты CodexWeb. Существующие проекты и аккаунты сохранятся. Продолжить?'))) { throw 'Установка отменена.' }
Write-CwStep 1 '1 из 5 · Приватное соединение Tailscale'
$tailscalePath = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
if (-not (Test-Path -LiteralPath $tailscalePath)) {
    Install-CwPackage 'Tailscale.Tailscale'
}
$address = Get-CwTailnetAddress $tailscalePath
if (-not $address) {
    Start-Process -FilePath (Join-Path $env:ProgramFiles 'Tailscale\tailscale-ipn.exe')
    if (-not (Confirm-Cw 'Войдите в Tailscale в открывшемся приложении. Владелец Hub должен предоставить вашему ПК доступ к своей приватной сети. Затем нажмите ОК.')) { throw 'Вход можно завершить при следующем запуске.' }
    $address = Get-CwTailnetAddress $tailscalePath
    if (-not $address) { throw 'Вход в Tailscale пока не завершён. Запустите мастер повторно после входа.' }
}
Write-CwStep 2 '2 из 5 · Папка ваших проектов'
$savedRoots = Join-Path $PSScriptRoot 'selected-roots.json'
$roots = if (Test-Path -LiteralPath $savedRoots) { @(Get-Content -LiteralPath $savedRoots -Raw -Encoding UTF8 | ConvertFrom-Json) } else { @() }
if (-not $roots.Count) {
    $suggestion = Join-Path $env:USERPROFILE 'Projects'
    if (-not (Test-Path -LiteralPath $suggestion)) { New-Item -ItemType Directory -Path $suggestion | Out-Null }
    $inputRoot = Select-CwRoot $suggestion
    $root = [IO.Path]::GetFullPath($inputRoot)
    if ($root -notmatch '^[A-Za-z]:\\' -or -not (Test-Path -LiteralPath $root -PathType Container)) { throw 'Выберите существующую папку на локальном диске.' }
    $check = $root
    while ($check) {
        if ((Get-Item -LiteralPath $check -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Project roots cannot contain junctions or symbolic links.' }
        $check = Split-Path -Parent $check
    }
    $roots = @($root)
    [IO.File]::WriteAllText($savedRoots, (ConvertTo-Json -InputObject $roots), [Text.UTF8Encoding]::new($false))
}
if (-not $roots.Count) { throw 'Select at least one project folder.' }
Write-CwStep 3 '3 из 5 · Программы и компоненты CodexWeb'
if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) { Install-CwPackage 'OpenJS.NodeJS.LTS' }
if (-not (Get-Command git.exe -ErrorAction SilentlyContinue)) { Install-CwPackage 'Git.Git' }
if (-not (Get-Command gh.exe -ErrorAction SilentlyContinue)) { Install-CwPackage 'GitHub.cli' }
$node = Get-Command node.exe -ErrorAction SilentlyContinue
$codex = Get-Command codex.exe -ErrorAction SilentlyContinue
if (-not $codex) {
    if (-not (Get-AppxPackage -Name OpenAI.Codex)) { Install-CwPackage '9PLM9XGG6VKS' 'msstore' }
    $candidates = @(Get-ChildItem -LiteralPath (Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin') -Filter codex.exe -Recurse -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTimeUtc -Descending)
    if (-not $candidates.Count) {
        $package = Get-AppxPackage -Name OpenAI.Codex
        if ($package) {
            $manifest = Get-AppxPackageManifest -Package $package.PackageFullName
            $appId = @($manifest.Package.Applications.Application)[0].Id
            if ($appId) { Start-Process ('shell:AppsFolder\' + $package.PackageFamilyName + '!' + $appId) }
        }
        if (-not (Confirm-Cw 'Откройте установленное приложение Codex, войдите в свой аккаунт и дождитесь его первоначальной подготовки. Затем нажмите ОК.')) { throw 'Вход можно завершить позже.' }
        $candidates = @(Get-ChildItem -LiteralPath (Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin') -Filter codex.exe -Recurse -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTimeUtc -Descending)
    }
    if ($candidates.Count) { $codex = [pscustomobject]@{ Source = $candidates[0].FullName } }
}
if (-not $node -or -not $codex) { throw 'Install stable Node.js and the native Codex application/CLI for this Windows account, sign in to Codex, then run this file again.' }
if (-not (Test-CwNativeLogin $codex.Source @('login', 'status') 'codex-login-status.log')) {
    if (-not (Confirm-Cw 'Сейчас откроется вход OpenAI. Войдите в свой аккаунт ChatGPT/Codex в браузере. Мастер дождётся завершения входа.')) { throw 'Вход в Codex отменён.' }
    Invoke-CwInstaller $codex.Source @('login')
    if (-not (Test-CwNativeLogin $codex.Source @('login', 'status') 'codex-login-status.log')) { throw 'Вход в Codex ещё не завершён. Настройки сохранены; откройте Connect.cmd после входа.' }
}
$ghCommand = Get-Command gh.exe -ErrorAction Stop
if (-not (Test-CwNativeLogin $ghCommand.Source @('auth', 'status', '--hostname', 'github.com') 'github-login-status.log')) {
    if (-not (Confirm-Cw 'Для работы с GitHub войдите в свой аккаунт. Сейчас откроется браузер; при необходимости GitHub покажет подтверждение доступа.')) { throw 'Вход в GitHub можно завершить при повторном запуске мастера.' }
    # Native gh stores its own credential in this Windows profile; none is sent to the Hub.
    Invoke-CwInstaller $ghCommand.Source @('auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web', '--clipboard') -GithubLogin
    if (-not (Test-CwNativeLogin $ghCommand.Source @('auth', 'status', '--hostname', 'github.com') 'github-login-status.log')) { throw 'Вход в GitHub ещё не завершён. Настройки сохранены; откройте Connect.cmd после входа.' }
}
$companionTask = Get-ScheduledTask -TaskName 'CodexWebCompanion' -ErrorAction SilentlyContinue
if ($companionTask -and $companionTask.State -eq 'Running') {
    $configPath = Join-Path $env:LOCALAPPDATA 'CodexWeb\companion\config.json'
    $existing = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if (@(Compare-Object @($existing.workingDirectories | Sort-Object) @($roots | Sort-Object)).Count) { throw 'Companion is running with other roots. Finish its tasks and stop the idle Companion before changing the roots. No running task was stopped.' }
} else { & (Join-Path $PSScriptRoot 'Install-Companion.ps1') -CodexCommand $codex.Source -WorkingDirectories $roots }
& (Join-Path $PSScriptRoot 'Install-ProjectSetup.ps1') -NodeCommand $node.Source -ProbePath (Join-Path $PSScriptRoot 'setupProbe.js')
& (Join-Path $PSScriptRoot 'Install-Delivery.ps1') -NodeCommand $node.Source -ProbePath (Join-Path $PSScriptRoot 'deliveryProbe.js')
& (Join-Path $PSScriptRoot 'Install-GuiPreview.ps1') -NodeCommand $node.Source
$gh = Get-Command gh.exe -ErrorAction SilentlyContinue
if ($gh) { & (Join-Path $PSScriptRoot 'Install-GitHubReleases.ps1') -NodeCommand $node.Source }
$desktop = @(Get-AppxPackage -Name OpenAI.Codex).Count -eq 1
if ($desktop) { & (Join-Path $PSScriptRoot 'Install-DesktopControl.ps1') -NodeCommand $node.Source }
$companion = Join-Path $env:LOCALAPPDATA 'CodexWeb\companion\CodexWebBridge.exe'
& $companion --probe | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Companion is not ready. No connection was activated.' }
Write-CwStep 4 '4 из 5 · Ключи компьютера и приватный доступ'
& (Join-Path $PSScriptRoot 'Pair-ComputerSsh.ps1') -Connection $connection
$hostKey = ((Get-Content -LiteralPath (Join-Path $env:ProgramData 'ssh\ssh_host_ed25519_key.pub') -Raw).Trim() -split ' ')[0..1] -join ' '
Show-CwFingerprint $hostKey
$remote = & (Join-Path $PSScriptRoot 'Install-EnrolledRemote.ps1') -Connection $connection -Window $script:CwWindow
$report = @{
    version = 1; address = $address.Trim(); hostKey = $hostKey
    machineGuid = $machineGuid
    sid = $identity.User.Value; username = $identity.Name.Split('\')[-1]; profile = $env:USERPROFILE; roots = @($roots)
    readiness = @{ companion = $true; codex = $true; node = $true; git = [bool](Get-Command git.exe -ErrorAction SilentlyContinue); github = [bool]$gh; desktop = $desktop; remote = [bool]$remote }
}
if ($remote) { $report.remote = $remote }
$report = $report | ConvertTo-Json -Depth 6 -Compress
# Keep the exact report before the network request to support safe acknowledgement recovery.
[IO.File]::WriteAllText($savedReport, $report, [Text.UTF8Encoding]::new($false))
Write-CwStep 5 '5 из 5 · Подтверждение подключения на сервере'
Submit-Report $report
Write-Host 'Prepared. Return to CodexWeb: the administrator checks the computer fingerprint, then you activate it in your own workspace.'
Write-Host 'Codex and GitHub use your existing local logins. ChatGPT sign-in is a separate step in your private connection page.'
