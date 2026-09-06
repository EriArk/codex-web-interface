[CmdletBinding()]
param(
    [ValidateSet('Status','Restart','ForceRestart','Probe','Run')][string]$Action='Status',
    [string]$RequestId
)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$controlRoot=[IO.Path]::GetFullPath($PSScriptRoot)
$config=Get-Content -LiteralPath (Join-Path $controlRoot 'config.json') -Raw | ConvertFrom-Json
$currentPath=Join-Path $controlRoot 'current.json'
$taskName='CodexWebDesktopRestart'
function Save-Operation($value) {
    $temporary=Join-Path $controlRoot 'current.tmp'
    [IO.File]::WriteAllText($temporary,($value | ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $currentPath -Force
}
function Read-Operation {
    if (Test-Path -LiteralPath $currentPath) { return Get-Content -LiteralPath $currentPath -Raw | ConvertFrom-Json }
    return $null
}
function Get-Desktop {
    $package=Get-AppxPackage -Name 'OpenAI.Codex' | Where-Object PackageFamilyName -EQ $config.packageFamily
    if (@($package).Count -ne 1) { throw 'DESKTOP_PACKAGE_UNAVAILABLE' }
    $exe=Join-Path $package.InstallLocation 'app\ChatGPT.exe'
    if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'DESKTOP_PACKAGE_UNAVAILABLE' }
    $processes=@(Get-CimInstance Win32_Process -Filter "Name = 'ChatGPT.exe'" | Where-Object {
        $_.ExecutablePath -and $_.ExecutablePath.Equals($exe,[StringComparison]::OrdinalIgnoreCase)
    } | Where-Object { (Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid).Sid -eq $config.userSid })
    return @{exe=$exe;processes=$processes}
}
function Get-Activity {
    $raw=& $config.nodeCommand --no-warnings (Join-Path $controlRoot 'desktop-activity.cjs') $config.codexHome
    if ($LASTEXITCODE -ne 0) { throw 'DESKTOP_ACTIVITY_UNAVAILABLE' }
    $activity=$raw | ConvertFrom-Json
    if (-not $activity.known) { throw 'DESKTOP_ACTIVITY_UNAVAILABLE' }
    return $activity
}
function Get-State([switch]$SkipActivity) {
    $desktop=Get-Desktop
    $known=$true; $active=0
    if ($SkipActivity) { $known=$false } else { try { $active=(Get-Activity).active } catch { $known=$false } }
    $operation=Read-Operation
    if ($operation -and $operation.state -in @('queued','restarting') -and [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()-$operation.requestedAt -gt 120) {
        $operation.state='unknown'; $operation.code='DESKTOP_OUTCOME_UNKNOWN'
    }
    return @{available=$true;running=($desktop.processes.Count -gt 0);activityKnown=$known;activeTasks=$active;operation=$operation}
}
function Complete-Operation($operation,[string]$state,[string]$code) {
    $operation.state=$state; $operation.code=$code; Save-Operation $operation
}
function Run-Operation {
    $operation=Read-Operation
    if (-not $operation -or $operation.state -ne 'queued') { return }
    if ([DateTimeOffset]::UtcNow.ToUnixTimeSeconds()-$operation.requestedAt -gt 90) {
        Complete-Operation $operation 'failed' 'DESKTOP_REQUEST_EXPIRED'; return
    }
    try {
        $session=(Get-Process -Id $PID).SessionId
        if ($session -eq 0) { throw 'DESKTOP_INTERACTIVE_SESSION_REQUIRED' }
        $desktop=Get-Desktop
        if (@($desktop.processes | Where-Object SessionId -NE $session).Count) { throw 'DESKTOP_OTHER_SESSION' }
        $force=$operation.kind -eq 'forcerestart'
        $activity=if ($force) { @{active=0} } else { Get-Activity }
        if ($operation.kind -eq 'probe') {
            Complete-Operation $operation 'completed' 'DESKTOP_INTERACTIVE_PROBE_OK'; return
        }
        if ($activity.active -gt 0) { throw 'DESKTOP_BUSY' }
        Complete-Operation $operation 'restarting' ''
        # Capture only this package's UI processes and their direct native App Server children.
        # Never stop all codex.exe processes: Companion owns an independent App Server.
        $uiIds=@($desktop.processes | ForEach-Object ProcessId)
        $children=@(Get-CimInstance Win32_Process -Filter "Name = 'codex.exe'" | Where-Object {
            $_.ParentProcessId -in $uiIds -and $_.SessionId -eq $session
        })
        if (-not $force) {
        foreach ($item in $desktop.processes) {
            $p=Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue
            if ($p -and $p.MainWindowHandle -ne 0) { $null=$p.CloseMainWindow() }
        }
        $deadline=[DateTime]::UtcNow.AddSeconds(6)
        do {
            Start-Sleep -Milliseconds 250
            $remaining=@((Get-Desktop).processes)
        } while ($remaining.Count -gt 0 -and [DateTime]::UtcNow -lt $deadline)
        # Recheck just before forced exit in case work began during the graceful-close window.
        if ((Get-Activity).active -gt 0) { throw 'DESKTOP_BUSY' }
        }
        foreach ($item in @($desktop.processes)+$children) {
            $p=Get-CimInstance Win32_Process -Filter ("ProcessId = " + $item.ProcessId)
            if ($p -and $p.CreationDate -eq $item.CreationDate -and $p.ExecutablePath -eq $item.ExecutablePath) {
                Stop-Process -Id $item.ProcessId -Force -ErrorAction Stop
            }
        }
        if ((Get-Desktop).processes.Count -gt 0) { throw 'DESKTOP_EXIT_FAILED' }
        # The user explicitly requested a visible desktop application via the web control.
        # Scheduled Task runs in that user's interactive session, never SSH Session 0.
        Start-Process -FilePath $desktop.exe -WorkingDirectory (Split-Path -Parent $desktop.exe) | Out-Null
        $deadline=[DateTime]::UtcNow.AddSeconds(20)
        do {
            Start-Sleep -Milliseconds 500
            $launched=@((Get-Desktop).processes | Where-Object SessionId -EQ $session)
        } while ($launched.Count -eq 0 -and [DateTime]::UtcNow -lt $deadline)
        if (-not $launched.Count) { throw 'DESKTOP_LAUNCH_FAILED' }
        Complete-Operation $operation 'completed' 'DESKTOP_RESTARTED'
    } catch {
        $code=[string]$_.Exception.Message
        if ($code -notmatch '^DESKTOP_[A-Z_]+$') { $code='DESKTOP_RESTART_FAILED' }
        Complete-Operation $operation 'failed' $code
    }
}
try {
    if ($Action -eq 'Status') { Get-State | ConvertTo-Json -Compress -Depth 4; exit 0 }
    if ($Action -eq 'Run') { Run-Operation; exit 0 }
    if ($RequestId -notmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') { throw 'DESKTOP_INVALID_REQUEST' }
    $lock=[IO.File]::Open((Join-Path $controlRoot 'request.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    try {
        $operation=Read-Operation
        if ($operation -and $operation.id -eq $RequestId) { Get-State | ConvertTo-Json -Compress -Depth 4; exit 0 }
        $task=Get-ScheduledTask -TaskName $taskName
        if ($task.State -eq 'Running') { throw 'DESKTOP_RESTART_PENDING' }
        if ($operation -and [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()-$operation.requestedAt -lt 60) { throw 'DESKTOP_RESTART_COOLDOWN' }
        $state=Get-State -SkipActivity:($Action -eq 'ForceRestart')
        if ($Action -ne 'ForceRestart' -and -not $state.activityKnown) { throw 'DESKTOP_ACTIVITY_UNAVAILABLE' }
        if ($Action -eq 'Restart' -and $state.activeTasks -gt 0) { throw 'DESKTOP_BUSY' }
        $operation=[pscustomobject]@{id=$RequestId;kind=$Action.ToLowerInvariant();state='queued';code='';requestedAt=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()}
        Save-Operation $operation
        try { Start-ScheduledTask -TaskName $taskName } catch {
            Complete-Operation $operation 'failed' 'DESKTOP_TASK_START_FAILED'; throw 'DESKTOP_TASK_START_FAILED'
        }
        Get-State -SkipActivity:($Action -eq 'ForceRestart') | ConvertTo-Json -Compress -Depth 4
    } finally { $lock.Dispose() }
} catch {
    $code=[string]$_.Exception.Message
    if ($code -notmatch '^DESKTOP_[A-Z_]+$') { $code='DESKTOP_CONTROL_UNAVAILABLE' }
    @{error=$code} | ConvertTo-Json -Compress
    exit 1
}
