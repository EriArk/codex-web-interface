Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()
$script:CwWindow = $null
function New-CwWindow {
    $form = [Windows.Forms.Form]::new()
    $form.Text = 'CodexWeb — подключение компьютера · v5'
    $form.Size = [Drawing.Size]::new(690, 520)
    $form.MinimumSize = [Drawing.Size]::new(590, 450)
    $form.StartPosition = 'CenterScreen'
    $form.Font = [Drawing.Font]::new('Segoe UI', 10)
    $form.BackColor = [Drawing.Color]::FromArgb(245, 247, 250)
    $layout = [Windows.Forms.TableLayoutPanel]::new()
    $layout.Dock = 'Fill'; $layout.Padding = [Windows.Forms.Padding]::new(24)
    $layout.ColumnCount = 1; $layout.RowCount = 4
    $layout.RowStyles.Add([Windows.Forms.RowStyle]::new('Absolute', 55)) | Out-Null
    $layout.RowStyles.Add([Windows.Forms.RowStyle]::new('Absolute', 34)) | Out-Null
    $layout.RowStyles.Add([Windows.Forms.RowStyle]::new('Percent', 100)) | Out-Null
    $layout.RowStyles.Add([Windows.Forms.RowStyle]::new('Absolute', 42)) | Out-Null
    $heading = [Windows.Forms.Label]::new()
    $heading.Text = 'Ваш компьютер · ваши аккаунты'; $heading.Dock = 'Fill'
    $heading.Font = [Drawing.Font]::new('Segoe UI', 17, [Drawing.FontStyle]::Bold)
    $script:CwProgress = [Windows.Forms.ProgressBar]::new()
    $script:CwProgress.Dock = 'Fill'; $script:CwProgress.Maximum = 5
    $script:CwLog = [Windows.Forms.TextBox]::new()
    $script:CwLog.Multiline = $true; $script:CwLog.ReadOnly = $true; $script:CwLog.ScrollBars = 'Vertical'
    $script:CwLog.Dock = 'Fill'; $script:CwLog.BorderStyle = 'None'; $script:CwLog.BackColor = $form.BackColor
    $script:CwLog.Margin = [Windows.Forms.Padding]::new(0, 20, 0, 12)
    $script:CwStatus = [Windows.Forms.Label]::new(); $script:CwStatus.Dock = 'Fill'
    foreach ($control in @($heading, $script:CwProgress, $script:CwLog, $script:CwStatus)) { $layout.Controls.Add($control) }
    $form.Controls.Add($layout); $script:CwWindow = $form
    $form.Show(); [Windows.Forms.Application]::DoEvents()
}
function Write-CwStep([int]$step, [string]$text) {
    if (Get-Command Save-CwEnrollmentStep -ErrorAction SilentlyContinue) { Save-CwEnrollmentStep $step }
    if ($script:CwWindow.IsDisposed) { throw 'Настройка закрыта. Запустите установщик повторно, чтобы продолжить.' }
    $script:CwProgress.Value = [Math]::Min(5, $step)
    $script:CwStatus.Text = $text
    $script:CwLog.AppendText($text + "`r`n`r`n")
    [Windows.Forms.Application]::DoEvents()
}
function Confirm-Cw([string]$text) {
    return [Windows.Forms.MessageBox]::Show($script:CwWindow, $text, 'CodexWeb', 'OKCancel', 'Information') -eq 'OK'
}
function Select-CwRoot([string]$initial) {
    $dialog = [Windows.Forms.FolderBrowserDialog]::new()
    $dialog.Description = 'Выберите папку для проектов CodexWeb. Другие папки не появятся в файловом менеджере сайта.'
    $dialog.SelectedPath = $initial; $dialog.ShowNewFolderButton = $true
    try {
        if ($dialog.ShowDialog($script:CwWindow) -ne 'OK') { throw 'Выбор папки отменён. Настройку можно продолжить позже.' }
        return $dialog.SelectedPath
    } finally { $dialog.Dispose() }
}
function Test-CwNativeLogin([string]$program, [string[]]$arguments, [string]$logName) {
    $previous = $ErrorActionPreference
    try {
        # PowerShell 5 turns native stderr into ErrorRecords even for an expected signed-out status.
        $ErrorActionPreference = 'Continue'
        & $program @arguments *> (Join-Path $PSScriptRoot $logName)
        return $LASTEXITCODE -eq 0
    } finally { $ErrorActionPreference = $previous }
}
function Get-CwTailnetAddress([string]$program) {
    $previous = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $address = @(& $program ip -4 2>$null) | Select-Object -First 1
        if ($LASTEXITCODE -eq 0 -and $address -match '^100\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$' -and [int]$Matches[1] -ge 64 -and [int]$Matches[1] -le 127 -and [int]$Matches[2] -le 255 -and [int]$Matches[3] -le 255) { return $address.Trim() }
        return $null
    } finally { $ErrorActionPreference = $previous }
}
function Invoke-CwInstaller([string]$program, [string[]]$arguments, [switch]$GithubLogin) {
    # Long dependency installation keeps the wizard responsive; close does not kill a package installer.
    $attempt = [Guid]::NewGuid().ToString('N')
    $stdout = Join-Path $PSScriptRoot ('installer-' + $attempt + '-output.log'); $stderr = Join-Path $PSScriptRoot ('installer-' + $attempt + '-error.log')
    if ($GithubLogin) {
        # Let the native login display its device code and accept input directly.
        # No shared input file or log reader is involved in authentication.
        $script:CwLog.AppendText("Завершите вход GitHub в отдельном окне: там показаны код и подсказки. После входа мастер продолжит настройку.`r`n`r`n")
        $process = Start-Process -FilePath $program -ArgumentList $arguments -WindowStyle Normal -PassThru
    } else {
        $process = Start-Process -FilePath $program -ArgumentList $arguments -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
    }
    # Windows PowerShell 5 needs a retained process handle to read ExitCode after exit.
    $processHandle = $process.Handle
    $startedAt = [DateTime]::UtcNow
    while (-not $process.HasExited) {
        [Windows.Forms.Application]::DoEvents(); [void]$process.WaitForExit(150)
        if (-not $script:CwWindow.IsDisposed -and ([DateTime]::UtcNow - $startedAt).TotalSeconds -ge 20) {
            $script:CwStatus.Text = 'Ожидаем завершения установки или входа в браузере…'
        }
    }
    $process.WaitForExit(); $exitCode = $process.ExitCode; $process.Dispose()
    if ($script:CwWindow.IsDisposed) { throw 'Установка компонента закончена. Запустите мастер повторно для продолжения.' }
    if ($exitCode -ne 0 -and $exitCode -ne 3010) { throw ('Не удалось завершить установку или вход (код ' + $exitCode + '). Повторный запуск сохранит уже выполненные шаги.') }
    # New processes otherwise retain the PATH from before Node/Git were installed.
    $env:Path = [Environment]::ExpandEnvironmentVariables([Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User'))
}
function Show-CwFingerprint([string]$hostKey) {
    $bytes = [Convert]::FromBase64String(($hostKey -split ' ')[1])
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $fingerprint = 'SHA256:' + [Convert]::ToBase64String($sha.ComputeHash($bytes)).TrimEnd('=') } finally { $sha.Dispose() }
    $script:CwLog.AppendText("Отпечаток этого компьютера:`r`n" + $fingerprint + "`r`n`r`nАдминистратор должен увидеть тот же отпечаток на сайте.`r`n")
    [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'computer-fingerprint.txt'), $fingerprint)
}
function Install-CwPackage([string]$id, [string]$source = 'winget') {
    $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
    if (-not $winget) {
        if (-not (Confirm-Cw 'Windows не содержит WinGet. Сейчас откроется официальный «Установщик приложений» Microsoft. Установите его, затем нажмите ОК.')) { throw 'Установка отменена.' }
        Start-Process 'ms-windows-store://pdp/?ProductId=9NBLGGH4NNS1'
        if (-not (Confirm-Cw 'После установки «Установщика приложений» нажмите ОК.')) { throw 'Установка отменена.' }
        $winget = Get-Command winget.exe -ErrorAction Stop
    }
    Invoke-CwInstaller $winget.Source @('install', '--id', $id, '--exact', '--source', $source, '--accept-source-agreements', '--accept-package-agreements', '--disable-interactivity', '--silent')
}
