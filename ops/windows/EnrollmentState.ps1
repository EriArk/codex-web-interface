# State contains only setup position and machine identity, never account credentials.
$script:CwEnrollmentStatePath = $null
$script:CwEnrollmentState = $null
function Initialize-CwEnrollmentState([string]$path, $connection, [string]$sid, [string]$machineGuid, [string]$profile) {
    $expected = @{ id = $connection.id; baseUrl = $connection.baseUrl; sid = $sid; machineGuid = $machineGuid; profile = $profile }
    if (Test-Path -LiteralPath $path) {
        if ((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Файл настройки содержит ссылку.' }
        $saved = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
        foreach ($key in $expected.Keys) {
            if ($saved.$key -cne $expected[$key]) { throw 'Этот пакет уже запускался для другого подключения или пользователя Windows. Скачайте свой пакет на сайте.' }
        }
        $expected.lastStep = [Math]::Max(0, [Math]::Min(5, [int]$saved.lastStep))
    } else { $expected.lastStep = 0 }
    $script:CwEnrollmentState = $expected
    $script:CwEnrollmentStatePath = $path
    Save-CwEnrollmentStep $expected.lastStep
    return $expected.lastStep
}
function Save-CwEnrollmentStep([int]$step) {
    if (-not $script:CwEnrollmentStatePath) { return }
    $script:CwEnrollmentState.lastStep = $step
    $temporary = $script:CwEnrollmentStatePath + '.tmp'
    if ((Test-Path -LiteralPath $temporary) -and ((Get-Item -LiteralPath $temporary -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Файл настройки содержит ссылку.' }
    [IO.File]::WriteAllText($temporary, ($script:CwEnrollmentState | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
    if (Test-Path -LiteralPath $script:CwEnrollmentStatePath) { [IO.File]::Replace($temporary, $script:CwEnrollmentStatePath, [NullString]::Value) }
    else { [IO.File]::Move($temporary, $script:CwEnrollmentStatePath) }
}
function Assert-CwReportIdentity($report, [string]$sid, [string]$machineGuid, [string]$profile) {
    if ($report.sid -cne $sid -or $report.machineGuid -cne $machineGuid -or $report.profile -cne $profile) {
        throw 'Сохранённый отчёт относится к другому компьютеру или пользователю Windows. Создайте своё подключение на сайте.'
    }
}
function Repair-CwEnrollmentReportRoots($report) {
    # PS5 serializes a pipeline-wrapped ConvertFrom-Json array as {value:[...],Count:n}.
    # Only repair that known invalid shape; a valid acknowledged report stays byte-identical.
    if (@($report.roots).Count -ne 1 -or $report.roots[0] -is [string]) { return $false }
    $wrapper = $report.roots[0]
    $keys = @($wrapper.PSObject.Properties.Name | Sort-Object)
    if (($keys -join ',') -ne 'Count,value' -or $wrapper.Count -ne @($wrapper.value).Count -or @($wrapper.value | Where-Object { $_ -isnot [string] }).Count) { throw 'Сохранённый список папок имеет неизвестный формат.' }
    $report.roots = [string[]]$wrapper.value
    return $true
}
