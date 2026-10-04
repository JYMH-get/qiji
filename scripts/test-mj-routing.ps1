$ErrorActionPreference='Stop'
$taskRoot=Split-Path -Parent $PSScriptRoot
$taskSandbox=Join-Path ([IO.Path]::GetTempPath()) ('qiji-mj-routing-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path "$taskSandbox/src","$taskSandbox/server/scripts","$taskSandbox/server/data" -Force | Out-Null
Copy-Item -LiteralPath "$taskRoot/src/contract.ts" -Destination "$taskSandbox/src/contract.ts"
Copy-Item -LiteralPath "$taskRoot/server/src","$taskRoot/server/skills" -Destination "$taskSandbox/server" -Recurse
Copy-Item -LiteralPath "$taskRoot/server/package.json" -Destination "$taskSandbox/server"
Copy-Item -LiteralPath "$taskRoot/server/scripts/smoke-mj-routing.mjs" -Destination "$taskSandbox/server/scripts"
Copy-Item -Path "$taskRoot/server/data/*.json" -Destination "$taskSandbox/server/data"
New-Item -ItemType Junction -Path "$taskSandbox/server/node_modules" -Target "$taskRoot/server/node_modules" | Out-Null
[IO.File]::WriteAllText("$taskSandbox/server/.qiji-mj-routing-sandbox",'Isolated data; no env; fetch disabled')
Push-Location "$taskSandbox/server"
try { & node --import tsx scripts/smoke-mj-routing.mjs; if($LASTEXITCODE -ne 0){throw 'routing smoke failed'} } finally { Pop-Location }
