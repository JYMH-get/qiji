param(
    [switch]$SkipTests,
    [switch]$NoOpen,
    [ValidateSet('patch', 'minor', 'major')] [string]$VersionIncrement = 'patch'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$projectRoot = Split-Path -Parent $PSScriptRoot
$buildStartedAt = Get-Date
$embeddedNyxenUploadKey = 'sk_7f71fe98b2664f5fa1605e8a'
$injectedEmbeddedNyxenKey = $false
$scriptExitCode = 0
$packageLock = $null
$packageLogDir = Join-Path $projectRoot 'outputs\client-packaging'
New-Item -ItemType Directory -Path $packageLogDir -Force | Out-Null
$packageLog = Join-Path $packageLogDir ("package-" + $buildStartedAt.ToString('yyyyMMdd-HHmmss') + '.log')
Start-Transcript -LiteralPath $packageLog | Out-Null

function Assert-File {
    param(
        [Parameter(Mandatory)] [string]$Path,
        [Parameter(Mandatory)] [string]$Label
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "缺少 $Label：$Path"
    }
}

function Invoke-Step {
    param(
        [Parameter(Mandatory)] [string]$Label,
        [Parameter(Mandatory)] [scriptblock]$Action
    )

    Write-Host "`n==> $Label" -ForegroundColor Cyan
    & $Action
    if ($LASTEXITCODE -ne 0) {
        throw "$Label 失败，退出码：$LASTEXITCODE"
    }
}

Set-Location -LiteralPath $projectRoot

try {
    try {
        $packageLock = [System.IO.File]::Open((Join-Path $packageLogDir 'package.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
    } catch {
        throw '已有打包程序正在运行，请等待完成后再试。'
    }
    Write-Host 'Qiji 可分享桌面应用打包' -ForegroundColor Green
    Write-Host "项目目录：$projectRoot"

    $injectedSigningKey = $false
    if ([string]::IsNullOrWhiteSpace($env:TAURI_SIGNING_PRIVATE_KEY)) {
        $qijiUpdaterKeyPath = Join-Path $env:USERPROFILE '.tauri\qiji-updater.key'
        Assert-File -Path $qijiUpdaterKeyPath -Label '客户端更新签名私钥（请从安全备份恢复，禁止临时换新密钥）'
        $env:TAURI_SIGNING_PRIVATE_KEY = $qijiUpdaterKeyPath
        # 本机初始密钥无口令；显式空值避免 CLI 在非交互发布任务中等待 stdin。
        if ($null -eq $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD) { $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = '' }
        $injectedSigningKey = $true
    }

    Assert-File -Path (Join-Path $projectRoot 'package.json') -Label 'package.json'
    Assert-File -Path (Join-Path $projectRoot 'node_modules\@tauri-apps\cli\tauri.js') -Label 'Tauri CLI（请先运行 npm install）'
    Assert-File -Path (Join-Path $projectRoot 'src-tauri\resources\ffmpeg\ffmpeg.exe') -Label 'FFmpeg'
    Assert-File -Path (Join-Path $projectRoot 'src-tauri\resources\libtv\libtv.exe') -Label 'LibTV CLI'
    Assert-File -Path (Join-Path $projectRoot 'src-tauri\resources\dreamina\dreamina.exe') -Label '即梦 CLI'

    if ([string]::IsNullOrWhiteSpace($env:NYXEN_UPLOAD_KEY)) {
        $env:NYXEN_UPLOAD_KEY = $embeddedNyxenUploadKey
        $injectedEmbeddedNyxenKey = $true
        Write-Host '已自动注入稳定模式加速桶专项密钥。' -ForegroundColor Green
    } else {
        Write-Host '已从当前打包进程环境读取加速桶专项密钥。' -ForegroundColor Green
    }

    $depthFiles = @(
        'public\depth-model\onnx-community\depth-anything-v2-small\config.json',
        'public\depth-model\onnx-community\depth-anything-v2-small\preprocessor_config.json',
        'public\depth-model\onnx-community\depth-anything-v2-small\onnx\model_q4f16.onnx',
        'public\depth-model\onnx-community\depth-anything-v2-small\onnx\model_quantized.onnx'
    )
    foreach ($depthFile in $depthFiles) {
        Assert-File -Path (Join-Path $projectRoot $depthFile) -Label '内置深度模型文件'
    }

    if (Test-Path -LiteralPath (Join-Path $projectRoot 'vite.config.js')) {
        throw '检测到 vite.config.js 残留；它会遮蔽 vite.config.ts，已停止打包。'
    }

    $tauriConfigPath = Join-Path $projectRoot 'src-tauri\tauri.conf.json'
    $tauriConfigText = Get-Content -LiteralPath $tauriConfigPath -Raw -Encoding UTF8
    $tauriConfig = $tauriConfigText | ConvertFrom-Json
    if ($tauriConfig.productName -ne 'Qiji' -or $tauriConfig.identifier -ne 'com.qiji.canvas') {
        throw 'Tauri productName 或 identifier 偏离稳定值，已停止打包以保护用户数据目录。'
    }
    foreach ($requiredArg in @('--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection', '--autoplay-policy=no-user-gesture-required', '--enable-features=WebGPU')) {
        if ($tauriConfig.app.windows[0].additionalBrowserArgs -notlike "*$requiredArg*") {
            throw "Tauri additionalBrowserArgs 缺少：$requiredArg"
        }
    }
    if ($tauriConfig.app.security.csp -notmatch "script-src[^;]*blob:") {
        throw 'Tauri CSP 的 script-src 缺少 blob:，已停止打包。'
    }

    $connectionStore = Get-Content -LiteralPath (Join-Path $projectRoot 'src\store\connectionStore.ts') -Raw -Encoding UTF8
    $serverMatch = [regex]::Match($connectionStore, 'import\.meta\.env\.DEV\s*\?\s*"http://localhost:8787"\s*:\s*"(?<url>https?://[^" ]+)"')
    if (-not $serverMatch.Success) {
        throw '无法确认 DEFAULT_SERVER_URL 的开发/生产分支，已停止打包。'
    }
    $productionServerUrl = $serverMatch.Groups['url'].Value
    Write-Host "正式版服务器：$productionServerUrl"

    if (-not $SkipTests) {
        Invoke-Step -Label '打包版本与说明测试' -Action { & node.exe --test scripts/client-release.test.mjs }
    }

    Invoke-Step -Label '同步递增客户端版本号' -Action {
        & node.exe scripts/client-release.mjs bump $projectRoot $VersionIncrement
    }
    $tauriConfig = Get-Content -LiteralPath $tauriConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json

    if (-not $SkipTests) {
        Invoke-Step -Label '客户端 TypeScript 检查' -Action { & npx.cmd tsc --noEmit }
        Invoke-Step -Label '客户端完整测试' -Action { & npx.cmd vitest run }
    } else {
        Write-Warning '已按参数跳过 TypeScript 与测试；不建议把该模式的产物直接对外发布。'
    }

    Invoke-Step -Label '前端正式构建' -Action { & npm.cmd run build }

    $assetFiles = @(Get-ChildItem -LiteralPath (Join-Path $projectRoot 'dist\assets') -Filter '*.js' -File)
    $assetPaths = @($assetFiles | ForEach-Object FullName)
    if (-not (Select-String -LiteralPath $assetPaths -SimpleMatch $productionServerUrl -Quiet)) {
        throw "dist 中未找到正式版服务器地址：$productionServerUrl"
    }
    if (Select-String -LiteralPath $assetPaths -SimpleMatch 'http://localhost:8787' -Quiet) {
        throw 'dist 中仍包含开发服务器地址 http://localhost:8787，已停止打包。'
    }
    Write-Host '正式版服务器地址产物核验通过。' -ForegroundColor Green

    Invoke-Step -Label 'Tauri 正式安装包构建' -Action { & npm.cmd run tauri -- build }

    $bundleRoot = Join-Path $projectRoot 'src-tauri\target\release\bundle'
    $packages = @(
        Get-ChildItem -LiteralPath $bundleRoot -Recurse -File -ErrorAction Stop |
            Where-Object { $_.Extension -in @('.exe', '.msi') -and $_.LastWriteTime -ge $buildStartedAt.AddMinutes(-1) }
    )
    if ($packages.Count -eq 0) {
        throw "打包命令完成，但未找到本轮新生成的 .exe 或 .msi：$bundleRoot"
    }
    foreach ($extension in @('.exe', '.msi')) {
        if (-not ($packages | Where-Object Extension -eq $extension)) {
            throw "本轮缺少 $extension 安装包，已停止发布旧产物。"
        }
    }

    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    Invoke-Step -Label '安装包与客户端内置公钥交叉验签' -Action {
        & node.exe scripts/verify-client-update.mjs @($packages | ForEach-Object FullName)
    }
    $shareDir = Join-Path $projectRoot "release\Qiji-$($tauriConfig.version)-$stamp"
    New-Item -ItemType Directory -Path $shareDir -Force | Out-Null
    foreach ($package in $packages) {
        Copy-Item -LiteralPath $package.FullName -Destination (Join-Path $shareDir $package.Name)
        Assert-File -Path ($package.FullName + '.sig') -Label '本轮安装包更新签名'
        Copy-Item -LiteralPath ($package.FullName + '.sig') -Destination (Join-Path $shareDir ($package.Name + '.sig'))
    }

    $updateExe = $packages | Where-Object Extension -eq '.exe' | Select-Object -First 1
    [ordered]@{
        version = $tauriConfig.version
        filename = $updateExe.Name
        signature = (Get-Content -LiteralPath ($updateExe.FullName + '.sig') -Raw).Trim()
        sha256 = (Get-FileHash -LiteralPath $updateExe.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        feedUrl = $tauriConfig.plugins.updater.endpoints[0]
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $shareDir 'update-release.json') -Encoding utf8

    Invoke-Step -Label '生成本版本更新说明和推送步骤' -Action {
        & node.exe scripts/client-release.mjs instructions $shareDir
    }

    $copiedPackages = @(Get-ChildItem -LiteralPath $shareDir -File | Sort-Object Name)
    $hashLines = foreach ($package in $copiedPackages) {
        $hash = Get-FileHash -LiteralPath $package.FullName -Algorithm SHA256
        "$($hash.Hash)  $($package.Name)"
    }
    Set-Content -LiteralPath (Join-Path $shareDir 'SHA256SUMS.txt') -Value $hashLines -Encoding UTF8
    [ordered]@{
        version = $tauriConfig.version
        builtAt = (Get-Date).ToString('o')
        serverUrl = $productionServerUrl
        testsSkipped = [bool]$SkipTests
        packages = @($copiedPackages | ForEach-Object { @{ name = $_.Name; bytes = $_.Length; sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash } })
    } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $shareDir 'build-info.json') -Encoding UTF8
    Set-Content -LiteralPath (Join-Path $packageLogDir 'latest-release.txt') -Value $shareDir -Encoding UTF8

    Write-Host "`n打包成功，可分享文件位于：" -ForegroundColor Green
    Write-Host $shareDir -ForegroundColor Yellow
    $copiedPackages | ForEach-Object {
        Write-Host ("  {0}  ({1:N1} MB)" -f $_.Name, ($_.Length / 1MB))
    }

    if (-not $NoOpen) {
        Start-Process explorer.exe -ArgumentList @($shareDir)
    }
} catch {
    Write-Host "`n打包失败：$($_.Exception.Message)" -ForegroundColor Red
    $scriptExitCode = 1
} finally {
    if ($packageLock) { $packageLock.Dispose() }
    if ($injectedSigningKey) { Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue }
    if ($injectedEmbeddedNyxenKey) {
        Remove-Item Env:NYXEN_UPLOAD_KEY -ErrorAction SilentlyContinue
        Write-Host '当前打包进程中的专项密钥已清除。' -ForegroundColor DarkGray
    }
    $embeddedNyxenUploadKey = $null
    Stop-Transcript | Out-Null
}

exit $scriptExitCode
