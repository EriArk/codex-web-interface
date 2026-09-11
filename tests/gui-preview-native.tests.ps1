[CmdletBinding()]
param([switch]$Interactive)
$ErrorActionPreference='Stop'
Add-Type -Path (Join-Path $PSScriptRoot '../ops/windows/PreviewWindow.cs') -ReferencedAssemblies System.Drawing
if([PreviewWindow]::Quote('a b') -ne '"a b"'){throw 'Windows quoting failed'}
if([PreviewWindow]::Quote('x\') -ne '"x\\"'){throw 'Trailing backslash quoting failed'}
if(-not $Interactive){Write-Output 'Native preview compiled; Windows argument quoting passed.';exit 0}
$directory=Join-Path $env:LOCALAPPDATA 'CodexWeb\gui-preview'
$allowlist=Join-Path $directory 'actions.json'
$original=[IO.File]::ReadAllText($allowlist)
$qaRoot=Join-Path $env:LOCALAPPDATA ('CodexWeb\qa-gui-preview-'+[guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $qaRoot|Out-Null
$app=Join-Path $qaRoot 'Sample.ps1'
$sample=@'
param([string]$Color='SteelBlue')
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$form=New-Object Windows.Forms.Form
$form.Text='CodexWeb isolated same-title preview'
$form.ClientSize=New-Object Drawing.Size(520,320)
$form.BackColor=[Drawing.Color]::FromName($Color)
$form.StartPosition='CenterScreen'
$label=New-Object Windows.Forms.Label
$label.Text='Disposable GUI preview';$label.ForeColor=[Drawing.Color]::White
$label.Font=New-Object Drawing.Font('Segoe UI',20)
$label.AutoSize=$true;$label.Location=New-Object Drawing.Point(35,110)
$form.Controls.Add($label)
$timer=New-Object Windows.Forms.Timer;$timer.Interval=90000;$timer.Add_Tick({$form.Close()});$timer.Start()
[Windows.Forms.Application]::Run($form)
'@
[IO.File]::WriteAllText($app,$sample,[Text.UTF8Encoding]::new($false))
$exe=Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$node=(Get-Command node.exe).Source;$worker=Join-Path $directory 'GuiPreviewWorker.cjs'
function Request($q){$envelope=@{root=$qaRoot;request=$q}|ConvertTo-Json -Depth 8 -Compress;$reply=$envelope|& $node $worker request;$r=$reply|ConvertFrom-Json;if(-not $r.ok){throw $r.code};return $r.value}
function Wait-Preview([string]$id){$until=[DateTime]::UtcNow.AddSeconds(35);do{$r=Request @{op='status';id=$id};if($r.state -in @('captured','failed','unknown')){return $r};Start-Sleep -Milliseconds 350}while([DateTime]::UtcNow -lt $until);throw 'Preview timed out'}
$operations=@();$evidence=@()
try{
 $actions=@()
 foreach($item in @(@{id='blue';color='SteelBlue'},@{id='orange';color='DarkOrange'})){$actions+=@{id=$item.id;label=$item.id;projectRoot=$qaRoot;executable=$exe;args=@('-NoProfile','-NonInteractive','-WindowStyle','Hidden','-File',$app,'-Color',$item.color);workingDirectory=$qaRoot;capture='window';startupTimeoutSeconds=20;keepAliveMinutes=1}}
 $actions+=@{id='early';label='Early exit';projectRoot=$qaRoot;executable=$exe;args=@('-NoProfile','-NonInteractive','-Command','exit 0');workingDirectory=$qaRoot;capture='window';startupTimeoutSeconds=3;keepAliveMinutes=1}
 $actions+=@{id='timeout';label='No window';projectRoot=$qaRoot;executable=$exe;args=@('-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 15');workingDirectory=$qaRoot;capture='window';startupTimeoutSeconds=3;keepAliveMinutes=1}
 $all=@($original|ConvertFrom-Json|Where-Object {$_})+$actions
 [IO.File]::WriteAllText($allowlist,($all|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
 $catalog=Request @{op='catalog'};if($catalog.actions.Count -ne 4){throw 'Wrong project catalog'}
 foreach($action in @('blue','orange')){
  $id=[guid]::NewGuid().ToString();$operations+=$id
  $null=Request @{op='start';id=$id;actionId=$action};$r=Wait-Preview $id
  if($r.state -ne 'captured' -or -not $r.appOpen){throw ($r|ConvertTo-Json -Compress)}
  $image=Request @{op='image';id=$id};$imagePath=Join-Path $qaRoot ($action+'.png');[IO.File]::WriteAllBytes($imagePath,[Convert]::FromBase64String($image.png))
  $bitmap=[Drawing.Bitmap]::FromFile($imagePath);try{$pixel=$bitmap.GetPixel(20,70);if($action -eq 'blue' -and $pixel.B -le $pixel.R){throw 'Wrong blue window'};if($action -eq 'orange' -and $pixel.R -le $pixel.B){throw 'Wrong orange window'};if($bitmap.GetPixel($bitmap.Width-2,$bitmap.Height-2).ToArgb() -eq [Drawing.Color]::Magenta.ToArgb()){throw 'DPI mismatch left an unpainted border'}}finally{$bitmap.Dispose()}
  $again=Request @{op='start';id=$id;actionId=$action};if($again.id -ne $id){throw 'Replay changed identity'}
  $evidence+=@{action=$action;id=$id;png=$imagePath;state=$r.state}
 }
 $null=Request @{op='stop';id=$operations[0]};Start-Sleep -Seconds 1
 if((Request @{op='status';id=$operations[0]}).appOpen){throw 'Own app did not close'}
 if(-not (Request @{op='status';id=$operations[1]}).appOpen){throw 'Unrelated same-title app was closed'}
 $null=Request @{op='stop';id=$operations[1]};Start-Sleep -Seconds 1
 foreach($case in @('early','timeout')){$id=[guid]::NewGuid().ToString();$operations+=$id;$null=Request @{op='start';id=$id;actionId=$case};$r=Wait-Preview $id;if($r.state -ne 'failed' -or $r.appOpen){throw 'Failure was not cleaned'};if($case -eq 'early' -and $r.code -ne 'PREVIEW_EARLY_EXIT'){throw $r.code};if($case -eq 'timeout' -and $r.code -ne 'PREVIEW_WINDOW_TIMEOUT'){throw $r.code}}
 Write-Output (@{interactive=$true;ownedWindow=$true;sameTitleIsolation=$true;exactRetry=$true;earlyExit=$true;timeout=$true;root=$qaRoot;evidence=$evidence}|ConvertTo-Json -Depth 6 -Compress)
}finally{
 foreach($id in $operations){try{$null=Request @{op='stop';id=$id};$null=Request @{op='ack';id=$id}}catch{}}
 [IO.File]::WriteAllText($allowlist,$original,[Text.UTF8Encoding]::new($false))
}
