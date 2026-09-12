param([string]$SourceRoot)
$ErrorActionPreference='Stop'
$avRoot=if($SourceRoot){(Resolve-Path $SourceRoot).Path}else{Split-Path $PSScriptRoot -Parent}
$avSandbox=Join-Path $env:TEMP ('qiji-availability-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory "$avSandbox/server/scripts","$avSandbox/src" -Force | Out-Null
Copy-Item "$avRoot/server/src","$avRoot/server/skills" "$avSandbox/server" -Recurse
Copy-Item "$avRoot/server/package.json","$avRoot/server/tsconfig.json" "$avSandbox/server"
Copy-Item "$avRoot/src/contract.ts" "$avSandbox/src"
Copy-Item "$PSScriptRoot/../server/scripts/smoke-channel-availability.mjs","$PSScriptRoot/../server/scripts/smoke-channel-availability-restart.mjs" "$avSandbox/server/scripts"
New-Item -ItemType Junction "$avSandbox/server/node_modules" -Target "$avRoot/server/node_modules" | Out-Null
Write-Output "AVAILABILITY_SANDBOX=$avSandbox"
Push-Location "$avSandbox/server"
try {
 & node --import tsx scripts/smoke-channel-availability.mjs
 if($LASTEXITCODE -ne 0){throw 'Availability checks failed'}
 & node --import tsx scripts/smoke-channel-availability-restart.mjs
 if($LASTEXITCODE -ne 0){throw 'Availability restart failed'}
}finally{Pop-Location}
