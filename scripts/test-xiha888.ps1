$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskSandbox = Join-Path ([IO.Path]::GetTempPath()) ('qiji-xiha888-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path "$taskSandbox/src", "$taskSandbox/server/scripts", "$taskSandbox/server/data" -Force | Out-Null
Copy-Item -LiteralPath "$taskRoot/src/contract.ts" -Destination "$taskSandbox/src/contract.ts"
Copy-Item -LiteralPath "$taskRoot/server/src", "$taskRoot/server/skills" -Destination "$taskSandbox/server" -Recurse
Copy-Item -LiteralPath "$taskRoot/server/package.json" -Destination "$taskSandbox/server"
Copy-Item -LiteralPath "$taskRoot/server/scripts/smoke-xiha888.mjs" -Destination "$taskSandbox/server/scripts"
Copy-Item -Path "$taskRoot/server/data/*.json" -Destination "$taskSandbox/server/data"
New-Item -ItemType Junction -Path "$taskSandbox/server/node_modules" -Target "$taskRoot/server/node_modules" | Out-Null
[IO.File]::WriteAllText("$taskSandbox/server/.qiji-xiha888-sandbox", 'isolated; fetch mocked; no env copied')
Push-Location "$taskSandbox/server"
try {
  & node -e "const fs=require('fs');fs.writeFileSync('retained.json',JSON.stringify(JSON.parse(fs.readFileSync('data/models.json')).models.filter(m=>m.id!=='xiha888-mj-imagine')));"
  & node --import tsx scripts/smoke-xiha888.mjs seed
  if ($LASTEXITCODE -ne 0) { throw 'seed failed' }
  & node -e "const fs=require('fs');fs.writeFileSync('retained.json',JSON.stringify(JSON.parse(fs.readFileSync('data/models.json')).models.filter(m=>m.id!=='xiha888-mj-imagine')));"
  $taskBefore = @(Get-ChildItem data -File -Filter '*.json' | Get-FileHash | Select-Object Path,Hash)
  & node --import tsx scripts/smoke-xiha888.mjs seed
  if ($LASTEXITCODE -ne 0) { throw 'second seed failed' }
  $taskAfter = @(Get-ChildItem data -File -Filter '*.json' | Get-FileHash | Select-Object Path,Hash)
  if (Compare-Object $taskBefore $taskAfter -Property Path,Hash) { throw 'second startup changed data' }
  & node --import tsx scripts/smoke-xiha888.mjs full
  if ($LASTEXITCODE -ne 0) { throw 'protocol checks failed' }
  Write-Output "XIHA888_SECOND_START_IDEMPOTENT=$($taskAfter.Count); SANDBOX=$taskSandbox"
} finally { Pop-Location }
