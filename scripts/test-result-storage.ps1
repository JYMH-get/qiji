$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$sandbox = Join-Path $env:TEMP ('qiji-result-storage-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path "$sandbox/src","$sandbox/server" -Force | Out-Null
Copy-Item "$root/src/contract.ts" "$sandbox/src/contract.ts"
Copy-Item "$root/server/src" "$sandbox/server/src" -Recurse
Copy-Item "$root/server/skills" "$sandbox/server/skills" -Recurse
New-Item -ItemType Directory -Path "$sandbox/server/scripts" | Out-Null
Copy-Item "$root/server/scripts/smoke-result-storage.mjs" "$sandbox/server/scripts/"
New-Item -ItemType Junction -Path "$sandbox/server/node_modules" -Target "$root/server/node_modules" | Out-Null
Copy-Item "$root/server/package.json" "$sandbox/server/package.json"
Push-Location "$sandbox/server"
try { & node --import tsx scripts/smoke-result-storage.mjs; if ($LASTEXITCODE -ne 0) { throw 'Result storage smoke failed' } }
finally { Pop-Location }
Write-Output "Sandbox: $sandbox"
