param([string]$SourceRoot,[switch]$IncludeControls)
$ErrorActionPreference='Stop'
$avRoot=if($SourceRoot){(Resolve-Path $SourceRoot).Path}else{Split-Path $PSScriptRoot -Parent}
$avSandbox=Join-Path $env:TEMP ('qiji-line-availability-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory "$avSandbox/server/scripts","$avSandbox/src" -Force | Out-Null
Copy-Item "$avRoot/server/src","$avRoot/server/skills" "$avSandbox/server" -Recurse
Copy-Item "$avRoot/server/package.json","$avRoot/server/tsconfig.json" "$avSandbox/server"
Copy-Item "$avRoot/src/contract.ts" "$avSandbox/src"
Copy-Item "$PSScriptRoot/../server/scripts/smoke-line-availability.mjs","$PSScriptRoot/../server/scripts/smoke-line-availability-restart.mjs" "$avSandbox/server/scripts"
if($IncludeControls){Copy-Item "$PSScriptRoot/../server/scripts/smoke-availability-controls.mjs","$PSScriptRoot/../server/scripts/smoke-availability-controls-restart.mjs" "$avSandbox/server/scripts"}
New-Item -ItemType Junction "$avSandbox/server/node_modules" -Target "$avRoot/server/node_modules" | Out-Null
Write-Output "AVAILABILITY_SANDBOX=$avSandbox"
Push-Location "$avSandbox/server"
try {
 & node --import tsx scripts/smoke-line-availability.mjs
 if($LASTEXITCODE -ne 0){throw 'Availability checks failed'}
 & node --import tsx scripts/smoke-line-availability-restart.mjs
 if($LASTEXITCODE -ne 0){throw 'Availability restart failed'}
 if($IncludeControls){
  & node --import tsx scripts/smoke-availability-controls.mjs
  if($LASTEXITCODE -ne 0){throw 'Availability controls failed'}
  & node --import tsx scripts/smoke-availability-controls-restart.mjs
  if($LASTEXITCODE -ne 0){throw 'Availability controls restart failed'}
 }
}finally{Pop-Location}

