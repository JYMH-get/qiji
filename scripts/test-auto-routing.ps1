param([switch]$LiveSource, [switch]$IncludeImages, [string]$SourceRoot)
$ErrorActionPreference = 'Stop'
$routingRoot = if ($SourceRoot) { (Resolve-Path -LiteralPath $SourceRoot).Path } else { Split-Path -Parent $PSScriptRoot }
$routingSandbox = Join-Path ([IO.Path]::GetTempPath()) ('qiji-routing-' + [guid]::NewGuid().ToString('N'))
$routingData = Join-Path $routingRoot 'server/data'
$routingHashFiles = if ($LiveSource) { @('models.json','modes.json','families.json','channels.json','auto-routing.json') | ForEach-Object { Join-Path $routingData $_ } | Where-Object { Test-Path -LiteralPath $_ } } else { Get-ChildItem -LiteralPath $routingData -File -Recurse | Select-Object -ExpandProperty FullName }
$routingBefore = @($routingHashFiles | ForEach-Object { Get-FileHash -LiteralPath $_ -Algorithm SHA256 } | Sort-Object Path | Select-Object Path, Hash)
New-Item -ItemType Directory -Path "$routingSandbox/src", "$routingSandbox/server/scripts", "$routingSandbox/server/data" -Force | Out-Null
Copy-Item -LiteralPath "$routingRoot/src/contract.ts" -Destination "$routingSandbox/src/contract.ts"
Copy-Item -LiteralPath "$routingRoot/server/src", "$routingRoot/server/skills" -Destination "$routingSandbox/server" -Recurse
Copy-Item -LiteralPath "$routingRoot/server/package.json", "$routingRoot/server/tsconfig.json" -Destination "$routingSandbox/server"
Copy-Item -LiteralPath "$routingRoot/server/scripts/smoke-auto-routing.mjs" -Destination "$routingSandbox/server/scripts"
if ($IncludeImages) { Copy-Item -LiteralPath "$routingRoot/server/scripts/smoke-image-routing.mjs" -Destination "$routingSandbox/server/scripts" }
# Only model capability/configuration snapshots; no users, business database, logs or production credentials.
foreach ($routingFile in @('models.json', 'modes.json', 'families.json', 'channels.json')) {
  $routingJson = Get-Content -LiteralPath (Join-Path $routingData $routingFile) -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($routingFile -eq 'models.json') {
    $routingJson.PSObject.Properties.Remove('seedanceVariantsFamilyVersion')
    foreach ($routingModel in $routingJson.models) {
      if ($routingModel.familyId -like 'fam-seedance-2-0-*') { $routingModel.familyId = 'fam-seedance' }
      $routingModel.PSObject.Properties.Remove('apiKey')
      $routingModel.PSObject.Properties.Remove('baseUrl')
    }
  }
  if ($routingFile -eq 'families.json') {
    $routingJson.PSObject.Properties.Remove('seedanceVariantsVersion')
    $routingJson.families = @($routingJson.families | Where-Object { $_.id -notlike 'fam-seedance-2-0-*' })
  }
  if ($routingFile -eq 'channels.json') {
    $routingJson = @{ channels = @($routingJson.channels | ForEach-Object {
      @{ id=$_.id; name=$_.name; enabled=$_.enabled; baseUrl='https://sandbox.image-routing.test'; apiKey='test-only' }
    }) }
  }
  [IO.File]::WriteAllText("$routingSandbox/server/data/$routingFile", ($routingJson | ConvertTo-Json -Depth 60))
}
New-Item -ItemType Junction -Path "$routingSandbox/server/node_modules" -Target "$routingRoot/server/node_modules" | Out-Null
[IO.File]::WriteAllText("$routingSandbox/server/.qiji-routing-sandbox", 'No real credentials or network.')
Write-Output "ROUTING_SANDBOX=$routingSandbox"
Push-Location "$routingSandbox/server"
try {
  & node --import tsx scripts/smoke-auto-routing.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Routing smoke failed' }
  & node --import tsx scripts/smoke-auto-routing.mjs restart
  if ($LASTEXITCODE -ne 0) { throw 'Routing restart verification failed' }
  if ($IncludeImages) {
    & node --import tsx scripts/smoke-image-routing.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Image routing smoke failed' }
    & node --import tsx scripts/smoke-image-routing.mjs restart
    if ($LASTEXITCODE -ne 0) { throw 'Image routing restart failed' }
  }
} finally {
  Pop-Location
  $routingAfter = @($routingHashFiles | ForEach-Object { Get-FileHash -LiteralPath $_ -Algorithm SHA256 } | Sort-Object Path | Select-Object Path, Hash)
  if ((ConvertTo-Json -InputObject $routingBefore -Compress) -cne (ConvertTo-Json -InputObject $routingAfter -Compress)) { throw 'Real source data changed during sandbox smoke' }
  Write-Output "ROUTING_SOURCE_DATA_UNCHANGED=$($routingAfter.Count) files; sandbox retained at $routingSandbox"
}
