$ErrorActionPreference='Stop'
$repo=Split-Path -Parent $PSScriptRoot
. ([scriptblock]::Create([IO.File]::ReadAllText((Join-Path $repo 'ops\windows\EnrollmentState.ps1'))))
foreach($inputJson in @('["D:\\Projects"]','["D:\\Projects","E:\\Work"]')) {
 $oldRoots=@($inputJson | ConvertFrom-Json)
 $oldReport=@{roots=@($oldRoots);remote=@{provider='vnc';port=5900;password='fixture1'}} | ConvertTo-Json -Depth 6 -Compress | ConvertFrom-Json
 if(-not (Repair-CwEnrollmentReportRoots $oldReport)){throw 'Legacy report not repaired'}
 $newRoots=[string[]]($inputJson | ConvertFrom-Json)
 $newReport=@{roots=@($newRoots);remote=@{provider='vnc';port=5900;password='fixture1'}} | ConvertTo-Json -Depth 6 -Compress | ConvertFrom-Json
 if(Repair-CwEnrollmentReportRoots $newReport){throw 'Valid report altered'}
 if(@(Compare-Object $newReport.roots $oldReport.roots).Count){throw 'Roots changed'}
 if($oldReport.remote.password -ne 'fixture1'){throw 'Remote altered'}
 $json=$oldReport | ConvertTo-Json -Depth 6 -Compress
 if($json -match '"value"|"Count"'){throw 'PS wrapper retained'}
}
'PASS: Windows PS5 real serialization, exact legacy repair, valid report and Remote preservation.'
