$ErrorActionPreference='Stop'
$config=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'config.json') -Raw -Encoding UTF8|ConvertFrom-Json
& $config.node (Join-Path $PSScriptRoot 'GuiPreviewWorker.cjs') work
exit $LASTEXITCODE
