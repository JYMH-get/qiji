$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskBeforeReal = @(Get-ChildItem "$taskRoot/server/data" -File -Filter '*.json' | Get-FileHash | Select-Object Path,Hash)
$taskSandbox = Join-Path ([IO.Path]::GetTempPath()) ('qiji-zongheng-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path "$taskSandbox/src", "$taskSandbox/server/scripts", "$taskSandbox/server/data" -Force | Out-Null
Copy-Item -LiteralPath "$taskRoot/src/contract.ts" -Destination "$taskSandbox/src/contract.ts"
Copy-Item -LiteralPath "$taskRoot/server/src", "$taskRoot/server/skills" -Destination "$taskSandbox/server" -Recurse
Copy-Item -LiteralPath "$taskRoot/server/package.json" -Destination "$taskSandbox/server"
Copy-Item -LiteralPath "$taskRoot/server/scripts/smoke-zongheng.mjs" -Destination "$taskSandbox/server/scripts"
Copy-Item -Path "$taskRoot/server/data/*.json" -Destination "$taskSandbox/server/data"
New-Item -ItemType Junction -Path "$taskSandbox/server/node_modules" -Target "$taskRoot/server/node_modules" | Out-Null
[IO.File]::WriteAllText("$taskSandbox/server/.qiji-zongheng-sandbox", 'isolated; fetch mocked; no env copied')
Push-Location "$taskSandbox/server"
try {
  & node -e "const fs=require('fs');fs.writeFileSync('retained.json',JSON.stringify(JSON.parse(fs.readFileSync('data/models.json')).models));"
  & node --import tsx scripts/smoke-zongheng.mjs seed
  if ($LASTEXITCODE -ne 0) { throw 'seed failed' }
  $taskBefore = @(Get-ChildItem data -File -Filter '*.json' | Get-FileHash | Select-Object Path,Hash)
  & node --import tsx scripts/smoke-zongheng.mjs seed
  if ($LASTEXITCODE -ne 0) { throw 'second seed failed' }
  $taskAfter = @(Get-ChildItem data -File -Filter '*.json' | Get-FileHash | Select-Object Path,Hash)
  if (Compare-Object $taskBefore $taskAfter -Property Path,Hash) { throw 'second startup changed data' }
  & node --import tsx scripts/smoke-zongheng.mjs full
  if ($LASTEXITCODE -ne 0) { throw 'protocol checks failed' }
  Write-Output "ALL_JSON_IDEMPOTENT; JSON_COUNT=$($taskAfter.Count); SANDBOX=$taskSandbox"
} finally { Pop-Location }
$taskAfterReal = @(Get-ChildItem "$taskRoot/server/data" -File -Filter '*.json' | Get-FileHash | Select-Object Path,Hash)
if (Compare-Object $taskBeforeReal $taskAfterReal -Property Path,Hash) { throw 'real data changed' }
Write-Output 'REAL_JSON_UNCHANGED; zero paid generation requests'
