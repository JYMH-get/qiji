$ErrorActionPreference = 'Stop'
$taskRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$taskSandbox = Join-Path $env:TEMP ('qiji-admin-search-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path "$taskSandbox/src","$taskSandbox/server/scripts" -Force | Out-Null
Copy-Item "$taskRoot/src/contract.ts" "$taskSandbox/src/contract.ts"
Copy-Item "$taskRoot/server/src" "$taskSandbox/server/src" -Recurse
Copy-Item "$taskRoot/server/skills" "$taskSandbox/server/skills" -Recurse
Copy-Item "$taskRoot/server/scripts/smoke-admin-search.mjs" "$taskSandbox/server/scripts/"
Copy-Item "$taskRoot/server/package.json" "$taskSandbox/server/package.json"
New-Item -ItemType Junction -Path "$taskSandbox/server/node_modules" -Target "$taskRoot/server/node_modules" | Out-Null
Push-Location "$taskSandbox/server"
try { & node --import tsx scripts/smoke-admin-search.mjs; if ($LASTEXITCODE -ne 0) { throw 'Admin search smoke failed' } }
finally { Pop-Location }
Write-Output "Sandbox: $taskSandbox"
