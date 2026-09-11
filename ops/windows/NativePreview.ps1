[CmdletBinding()]
param([Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9-]{36}$')][string]$OperationId,[Parameter(Mandatory=$true)][int]$WorkerPid)
$ErrorActionPreference='Stop'
$directory=Join-Path $PSScriptRoot 'state'
$record=Get-Content -LiteralPath (Join-Path $directory ($OperationId+'.request.json')) -Raw -Encoding UTF8 | ConvertFrom-Json
$progress=Join-Path $directory ($OperationId+'.progress.json')
$stopFile=Join-Path $directory ($OperationId+'.stop.json')
$preview=$null;$captured=$false;$code='PREVIEW_LAUNCH';$worker=Get-Process -Id $WorkerPid -ErrorAction Stop;$workerStart=$worker.StartTime
function Save-Progress([string]$stage,[bool]$opened,[string]$failure='') {
 $data=@{state=$stage;appOpen=$opened};if($failure){$data.code=$failure}
 $temporary=$progress+'.tmp'
 [IO.File]::WriteAllText($temporary,($data|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
 if(Test-Path -LiteralPath $progress){[IO.File]::Replace($temporary,$progress,[NullString]::Value)}else{[IO.File]::Move($temporary,$progress)}
}
try {
 Save-Progress 'launching' $false
 Add-Type -Path (Join-Path $PSScriptRoot 'PreviewWindow.cs') -ReferencedAssemblies 'System.Drawing'
 if(Test-Path -LiteralPath $stopFile){throw 'PREVIEW_STOPPED'}
 $a=$record.action
 $preview=[PreviewWindow]::new([string]$a.executable,[string[]]$a.args,[string]$a.workingDirectory)
 Save-Progress 'waiting' $true
 $deadline=[DateTime]::UtcNow.AddSeconds([int]$a.startupTimeoutSeconds);$previous='';$stable=0
 while([DateTime]::UtcNow -lt $deadline){
  if(Test-Path -LiteralPath $stopFile){throw 'PREVIEW_STOPPED'}
  $worker.Refresh();if($worker.HasExited -or $worker.StartTime -ne $workerStart){throw 'PREVIEW_WORKER_EXIT'}
  if(-not $preview.Alive){throw 'PREVIEW_EARLY_EXIT'}
  $window=$preview.Find();$bounds=$preview.Bounds($window)
  if($bounds -and $bounds -eq $previous){$stable++}else{$stable=0};$previous=$bounds
  if($stable -ge 3){
   $captureCode=$preview.Capture($window,(Join-Path $directory ($OperationId+'.png')),($a.capture -eq 'desktop-crop'))
   if(-not $captureCode){$captured=$true;break}
   if($captureCode -eq 'PREVIEW_CAPTURE_TIMEOUT'){throw $captureCode}
   $code=$captureCode
  }
  Start-Sleep -Milliseconds 350
 }
 if(-not $captured){if($code -eq 'PREVIEW_LAUNCH'){$code='PREVIEW_WINDOW_TIMEOUT'};throw $code}
 Save-Progress 'captured' $true
 while($preview.Alive -and [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt [long]$record.expiresAt){
  if(Test-Path -LiteralPath $stopFile){break}
  $worker.Refresh();if($worker.HasExited -or $worker.StartTime -ne $workerStart){break}
  Start-Sleep -Milliseconds 500
 }
}catch{
 $message=$_.Exception.Message
 if($message -match 'PREVIEW_[A-Z_]+'){$code=$matches[0]}else{$code='PREVIEW_CAPTURE'}
}finally{
 if($preview){$preview.Dispose()}
 if($captured){Save-Progress 'captured' $false}else{Save-Progress 'failed' $false $code}
}
