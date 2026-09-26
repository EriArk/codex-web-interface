#Requires -Version 5.1
[CmdletBinding()]
param([switch]$RepairExistingServices, [switch]$NoPause,
      [string]$ConnectionFile = (Join-Path $PSScriptRoot 'diagnostic-target.json'),
      [string]$OutputDirectory = ([Environment]::GetFolderPath('Desktop')))
$ErrorActionPreference = 'Stop'

function Invoke-CwDiagnosticCommand([string]$File, [string]$Arguments) {
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $File; $info.Arguments = $Arguments
    $info.UseShellExecute = $false; $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
    $process = [Diagnostics.Process]::Start($info)
    try {
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(12000)) { $process.Kill(); throw 'COMMAND_TIMEOUT' }
        # Raw stderr can include account or authorization data. Never put it in the report.
        return @{ code = $process.ExitCode; text = $stdout.Result }
    } finally { $process.Dispose() }
}
function Test-CwSshBoundary([string]$HubAddress) {
    $block = Get-NetFirewallRule -PolicyStore ActiveStore -Name 'CodexWeb-Enrolled-Private-22' -ErrorAction Stop
    $port = $block | Get-NetFirewallPortFilter
    $program = $block | Get-NetFirewallApplicationFilter
    $addresses = @(($block | Get-NetFirewallAddressFilter).RemoteAddress)
    $octets = @($HubAddress.Split('.') | ForEach-Object { [int]$_ })
    $number = [long]$octets[0]*16777216 + [long]$octets[1]*65536 + [long]$octets[2]*256 + $octets[3]
    $toIp = { param([long]$value) (@(24,16,8,0 | ForEach-Object { ($value -shr $_) -band 255 })) -join '.' }
    $expected = @("0.0.0.0-$(& $toIp ($number-1))", "$(& $toIp ($number+1))-255.255.255.255", '::/1', '8000::/1')
    return (@(Get-NetFirewallProfile -PolicyStore ActiveStore | Where-Object { [string]$_.Enabled -ne 'True' }).Count -eq 0 -and
        @($block).Count -eq 1 -and [string]$block.Enabled -eq 'True' -and [string]$block.Action -eq 'Block' -and
        [string]$block.Direction -eq 'Inbound' -and [string]$block.Profile -eq 'Any' -and
        [string]$port.Protocol -in @('TCP','6') -and [string]$port.LocalPort -eq '22' -and
        [string]$program.Program -eq (Join-Path $env:WINDIR 'System32\OpenSSH\sshd.exe') -and
        @(Compare-Object $expected $addresses).Count -eq 0)
}
function Repair-CwServices([bool]$IdentityMatches, [bool]$Administrator, [string]$HubAddress) {
    $actions = @()
    if (-not $IdentityMatches) { return @('REFUSED: package belongs to another Windows user or computer') }
    if (-not $Administrator) { return @('REFUSED: administrator rights required for service recovery') }
    foreach ($name in @('Tailscale','sshd')) {
        try {
            $service = Get-Service -Name $name -ErrorAction Stop
            if ($service.Status -eq 'Running') { $actions += "$name already running; untouched"; continue }
            if ($name -eq 'sshd' -and -not (Test-CwSshBoundary $HubAddress)) {
                $actions += 'sshd not started: existing Hub-only firewall boundary could not be verified'; continue
            }
            # Never restart running processes, replace credentials, change startup policy or enable disabled services.
            Start-Service -Name $name -ErrorAction Stop
            $actions += "$name start requested"
        } catch { $actions += "$name could not be started ($($_.Exception.GetType().Name))" }
    }
    return $actions
}
function Invoke-CwConnectionDiagnostic {
    $config = Get-Content -LiteralPath $ConnectionFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $hub = [string]$config.hubAddress
    if ($hub -notmatch '^100\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$' -or [int]$Matches[1] -lt 64 -or [int]$Matches[1] -gt 127 -or [int]$Matches[2] -gt 255 -or [int]$Matches[3] -gt 255) { throw 'Invalid private Hub address' }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $admin = ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    $guidMatches = $false
    try { $guidMatches = (Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Cryptography').MachineGuid -eq $config.machineGuid } catch {}
    $userMatches = $identity.User.Value -eq $config.sid
    $report = [ordered]@{ version = 1; at = [DateTime]::UtcNow.ToString('o'); computer = $env:COMPUTERNAME; user = $env:USERNAME;
        expectedUser = [bool]$userMatches; expectedComputer = [bool]$guidMatches; administrator = [bool]$admin; hub = $hub;
        repairRequested = [bool]$RepairExistingServices; repair = @(); services = @(); tailscale = @{}; ssh = @{}; helpers = @(); tasks = @(); tools = @(); findings = @() }
    if ($RepairExistingServices) { $report.repair = @(Repair-CwServices ($userMatches -and $guidMatches) $admin $hub) }
    if (-not $userMatches -or -not $guidMatches) { $report.findings += 'Запусти пакет в своей обычной учётной записи на подключённом к CodexWeb ПК. Этот пользователь или компьютер не совпадает с подключением.' }
    foreach ($name in @('Tailscale','sshd')) {
        try {
            $service = Get-Service -Name $name -ErrorAction Stop
            $report.services += @{ name=$name; state=[string]$service.Status; startup=[string]$service.StartType }
            if ($service.Status -ne 'Running') { $report.findings += "Служба $name не работает. Используй 02-Repair-services.cmd." }
        } catch { $report.services += @{name=$name; state='Unavailable'}; $report.findings += "Служба $name отсутствует или недоступна." }
    }
    $cli = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
    try {
        $result = Invoke-CwDiagnosticCommand $cli 'status --json'
        if ($result.code -ne 0) { throw 'TAILSCALE_STATUS_FAILED' }
        $status = $result.text | ConvertFrom-Json
        $peer = @($status.Peer.PSObject.Properties | ForEach-Object { $_.Value } | Where-Object { @($_.TailscaleIPs) -contains $hub })
        $report.tailscale = @{ state=$status.BackendState; selfOnline=$status.Self.Online; addresses=@($status.TailscaleIPs);
            hubVisible=($peer.Count -eq 1); hubOnline=($peer.Count -eq 1 -and $peer[0].Online); network=$status.CurrentTailnet.Name }
        if ($status.BackendState -ne 'Running' -or $peer.Count -ne 1) {
            $report.findings += 'Tailscale не подключён к сети с нашим Hub. Открой Tailscale, войди своим аккаунтом и выбери сеть, в которой виден codex-web-hub. Не выходи из GitHub/Codex.'
        } else {
            $tcp = New-Object Net.Sockets.TcpClient
            try {
                $connection = $tcp.ConnectAsync($hub, 443)
                $report.tailscale.hubHttpsTcp = ($connection.Wait(5000) -and $tcp.Connected)
            } catch { $report.tailscale.hubHttpsTcp = $false } finally { $tcp.Dispose() }
            if (-not $report.tailscale.hubHttpsTcp) { $report.findings += 'Hub есть в списке Tailscale, но его порт HTTPS не ответил. Передай отчёт администратору.' }
        }
    } catch { $report.tailscale.error = $_.Exception.GetType().Name; $report.findings += 'Не удалось прочитать состояние Tailscale; проверь установку и службу.' }
    try { $report.ssh.hubOnlyBoundary = [bool](Test-CwSshBoundary $hub) } catch { $report.ssh.hubOnlyBoundary = 'Unavailable' }
    try {
        $report.ssh.listeners = @(Get-NetTCPConnection -State Listen -LocalPort 22 -ErrorAction Stop | Select-Object LocalAddress,LocalPort)
    } catch { $report.ssh.listeners = @() }
    try {
        $report.ssh.rules = @(Get-NetFirewallRule -PolicyStore ActiveStore -ErrorAction Stop | Where-Object { $_.Name -like 'CodexWeb*' -or $_.Name -eq 'OpenSSH-Server-In-TCP' } | ForEach-Object {
            $rule = $_; $port = $rule | Get-NetFirewallPortFilter; $address = $rule | Get-NetFirewallAddressFilter
            @{name=$rule.Name; enabled=[string]$rule.Enabled; action=[string]$rule.Action; direction=[string]$rule.Direction; port=[string]$port.LocalPort; remote=@($address.RemoteAddress)}
        })
    } catch { $report.ssh.rules = 'Unavailable (run elevated diagnostic for firewall details)' }
    foreach ($name in @('node.exe','git.exe','gh.exe')) {
        $command = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
        $report.tools += @{name=$name; found=($null -ne $command); path=$command.Source}
    }
    $appRoot = Join-Path $env:LOCALAPPDATA 'CodexWeb'
    foreach ($file in @('project-setup\ProjectSetupWorker.cjs','project-setup\Run-ProjectSetup.ps1','project-setup\setupProbe.js','delivery\DeliveryWorker.cjs','delivery\githubWorkProbe.js','companion\CodexWebBridge.exe')) {
        try { $hash = (Get-FileHash -LiteralPath (Join-Path $appRoot $file) -Algorithm SHA256 -ErrorAction Stop).Hash }
        catch { $hash = 'MISSING_OR_UNREADABLE' }
        $report.helpers += @{file=$file; sha256=$hash}
    }
    foreach ($name in @('CodexWebProjectSetup','CodexWebDelivery','CodexWebCompanion')) {
        try {
            $task = Get-ScheduledTask -TaskName $name -ErrorAction Stop
            $info = Get-ScheduledTaskInfo -TaskName $name -ErrorAction Stop
            $report.tasks += @{name=$name; state=[string]$task.State; lastResult=$info.LastTaskResult; lastRun=$info.LastRunTime.ToString('o'); principal=$task.Principal.UserId}
        } catch { $report.tasks += @{name=$name; state='MISSING_OR_UNREADABLE'} }
    }
    if (-not $report.findings.Count) { $report.findings += 'Локальные проверки выполнены. Передай отчёт: администратор проверит входящий SSH с Hub. Этот отчёт сам по себе не подтверждает удалённый доступ.' }
    $reportName = 'CodexWeb-Diagnostic-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0,6)
    $file = Join-Path $OutputDirectory ($reportName + '.json')
    $textFile = Join-Path $OutputDirectory ($reportName + '.txt')
    [IO.File]::WriteAllText($file, ($report | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($true))
    $summary = @('CodexWeb — проверка подключения', "Время UTC: $($report.at)", "Компьютер: $($report.computer)", "Пользователь: $($report.user)", '', 'Результат:') + @($report.findings) + @('', 'Восстановление служб:') + @($report.repair) + @('', "Подробный отчёт: $file", 'Отправь оба файла человеку, который дал этот пакет. Файлы не отправляются автоматически.')
    [IO.File]::WriteAllLines($textFile, [string[]]$summary, [Text.UTF8Encoding]::new($true))
    Write-Host ($summary -join [Environment]::NewLine)
}
if ($MyInvocation.InvocationName -ne '.') {
    try { Invoke-CwConnectionDiagnostic }
    catch { Write-Host ('Проверка не завершена: ' + $_.Exception.Message) -ForegroundColor Red }
    if (-not $NoPause) { [void](Read-Host 'Нажми Enter, чтобы закрыть окно') }
}
