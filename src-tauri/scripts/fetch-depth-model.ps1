# Fetch the bundled depth-estimation model (Depth Anything V2-Small, ONNX).
# Files land in public/depth-model/ and are shipped inside the installer (round 202).
# Not committed to git (~45MB) - run this script after a fresh clone, like fetch-ffmpeg.ps1.
#
# Source: hf-mirror.com (same upstream the server gateway /v1/depth-model proxies).
# Alternative offline source: copy server/data/depth-model/* from a dev server cache.

$ErrorActionPreference = "Stop"

$repo = "onnx-community/depth-anything-v2-small"
$base = "https://hf-mirror.com/$repo/resolve/main"
$destRoot = Join-Path $PSScriptRoot "..\..\public\depth-model\$repo"

$files = @(
    "config.json",
    "preprocessor_config.json",
    "onnx/model_q4f16.onnx",     # WebGPU fast path (~19MB)
    "onnx/model_quantized.onnx"  # WASM q8 fallback (~26MB)
)

foreach ($f in $files) {
    $dest = Join-Path $destRoot ($f -replace "/", "\")
    $dir = Split-Path $dest -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
    if (Test-Path $dest) {
        Write-Host "skip (exists): $f"
        continue
    }
    Write-Host "downloading: $f"
    Invoke-WebRequest -Uri "$base/$f" -OutFile $dest -UseBasicParsing
}

Write-Host "done. files under: $destRoot"
