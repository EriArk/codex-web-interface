#Requires -Version 5.1
[CmdletBinding()]
param([string]$HubAddress = '100.79.63.56', [string]$NetworkOwner = 'lazarstafeev@gmail.com')
$ErrorActionPreference = 'Stop'

function Test-CwHubPeer($Status, [string]$Address) {
    if ($Status.BackendState -ne 'Running' -or -not $Status.Peer) { return $false }
    foreach ($entry in $Status.Peer.PSObject.Properties) {
        if (@($entry.Value.TailscaleIPs) -contains $Address) { return $true }
    }
    return $false
}

function Get-CwTailnetStatus([string]$Executable) {
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $Executable
    $info.Arguments = 'status --json'
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $proc = [Diagnostics.Process]::Start($info)
    try {
        $output = $proc.StandardOutput.ReadToEndAsync()
        $errors = $proc.StandardError.ReadToEndAsync()
        if (-not $proc.WaitForExit(15000)) { $proc.Kill(); throw 'Tailscale не ответил за 15 секунд. Попробуйте запустить этот файл ещё раз.' }
        if ($proc.ExitCode -ne 0) { throw 'Не удалось прочитать состояние Tailscale. Проверьте, что его служба запущена.' }
        return ($output.Result | ConvertFrom-Json)
    } finally { $proc.Dispose() }
}

function Invoke-CwMemberConnect {
    $cli = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
    if (-not (Test-Path -LiteralPath $cli)) { throw 'Tailscale не найден. Установите его с https://tailscale.com/download/windows и запустите этот файл снова.' }
    $service = Get-Service -Name Tailscale -ErrorAction SilentlyContinue
    if ($service -and $service.Status -ne 'Running') { Start-Service -Name Tailscale }
    $status = Get-CwTailnetStatus $cli
    if (-not (Test-CwHubPeer $status $HubAddress)) {
        Write-Host "Откроется браузер. Войдите СВОИМ GitHub (neflores)." -ForegroundColor Cyan
        Write-Host "При выборе сети выберите: $NetworkOwner" -ForegroundColor Yellow
        Write-Host 'Не выбирайте личную сеть neflores.github. Это окно оставьте открытым.'
        $info = New-Object Diagnostics.ProcessStartInfo
        $info.FileName = $cli
        $info.Arguments = 'login'
        $info.UseShellExecute = $false
        $info.CreateNoWindow = $true
        $info.RedirectStandardOutput = $true
        $info.RedirectStandardError = $true
        $login = [Diagnostics.Process]::Start($info)
        try {
            $streams = @($login.StandardOutput, $login.StandardError)
            $pending = @($streams[0].ReadLineAsync(), $streams[1].ReadLineAsync())
            $opened = $false
            $deadline = [DateTime]::UtcNow.AddMinutes(10)
            while ([DateTime]::UtcNow -lt $deadline) {
                for ($i = 0; $i -lt 2; $i++) {
                    if ($pending[$i] -and $pending[$i].IsCompleted) {
                        $line = $pending[$i].Result
                        if ($null -eq $line) { $pending[$i] = $null; continue }
                        Write-Host $line
                        if (-not $opened -and $line -match 'https://login\.tailscale\.com/[A-Za-z0-9/?=&_%.-]+') {
                            Start-Process -FilePath $Matches[0]
                            $opened = $true
                        }
                        $pending[$i] = $streams[$i].ReadLineAsync()
                    }
                }
                if ($login.HasExited -and -not $pending[0] -and -not $pending[1]) { break }
                Start-Sleep -Milliseconds 100
            }
            if (-not $login.HasExited) { $login.Kill(); throw 'Вход не завершён за 10 минут. Запустите файл снова, когда будете готовы войти в браузере.' }
            if ($login.ExitCode -ne 0) { throw 'Вход Tailscale не завершился. Сообщение причины показано выше.' }
        } finally { if (-not $login.HasExited) { $login.Kill() }; $login.Dispose() }
        for ($attempt = 0; $attempt -lt 10; $attempt++) {
            $status = Get-CwTailnetStatus $cli
            if (Test-CwHubPeer $status $HubAddress) { break }
            Start-Sleep -Seconds 2
        }
    }
    $visible = Test-CwHubPeer $status $HubAddress
    $report = @("Computer: $env:COMPUTERNAME", "Network: $($status.CurrentTailnet.Name)", "Addresses: $(@($status.TailscaleIPs) -join ', ')", "Hub visible: $visible", "Hub: $HubAddress") -join [Environment]::NewLine
    $path = Join-Path ([Environment]::GetFolderPath('Desktop')) 'CodexWeb-Tailscale.txt'
    [IO.File]::WriteAllText($path, $report, [Text.UTF8Encoding]::new($true))
    Write-Host $report
    Write-Host "Отчёт на рабочем столе: $path"
    if (-not $visible) { throw "Наш Hub пока не виден. Отправьте CodexWeb-Tailscale.txt администратору: возможно, выбрана другая сеть или нужно одобрить устройство." }
    Write-Host 'Наш Hub появился в Tailscale. Передайте отчёт администратору для завершения подключения CodexWeb.' -ForegroundColor Green
}

if ($MyInvocation.InvocationName -ne '.') {
    try { Invoke-CwMemberConnect } catch { Write-Host $_.Exception.Message -ForegroundColor Red }
    [void](Read-Host 'Нажмите Enter, чтобы закрыть окно')
}
