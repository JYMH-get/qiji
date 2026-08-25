# 拉取并内置 Windows 版 LibTV CLI（libtv.exe）到 src-tauri/resources/libtv/libtv.exe
# 该二进制随 Tauri 打包进应用（bundle.resources），供「LibTV 授权 / Seedance 2.0 生成」原生调用。
# 版本锁定（与官方 skill 文档同源）：https://liblibai-web-static.liblib.cloud/cli/<版本>/libtv-windows-amd64.zip
# 体积约 22MB 不入 git，克隆后或换机时运行本脚本一次即可。
#   用法：powershell -ExecutionPolicy Bypass -File src-tauri/scripts/fetch-libtv.ps1
#   换版本：$env:LIBTV_CLI_VERSION='x.y.z' 后重跑（先删旧 exe）
$ErrorActionPreference = 'Stop'
$ver  = if ($env:LIBTV_CLI_VERSION) { $env:LIBTV_CLI_VERSION } else { '1.1.3' }
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'amd64' }
$root = Split-Path -Parent (Split-Path -Parent $PSCommandPath)   # = src-tauri
$dest = Join-Path $root 'resources\libtv'
$exe  = Join-Path $dest 'libtv.exe'
if (Test-Path $exe) { Write-Host "已存在：$exe（删除后重跑可更新）"; exit 0 }
New-Item -ItemType Directory -Force -Path $dest | Out-Null
$url = "https://liblibai-web-static.liblib.cloud/cli/$ver/libtv-windows-$arch.zip"
$zip = Join-Path $env:TEMP ("libtv-fetch-{0}.zip" -f ([guid]::NewGuid().ToString('N')))
Write-Host "下载 LibTV CLI v$ver（$arch，约 22MB）…"
Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
Add-Type -AssemblyName System.IO.Compression.FileSystem
$z = [System.IO.Compression.ZipFile]::OpenRead($zip)
$entry = $z.Entries | Where-Object { $_.FullName -match 'libtv\.exe$' } | Select-Object -First 1
if (-not $entry) { $z.Dispose(); Remove-Item $zip -Force; throw '压缩包内未找到 libtv.exe' }
[System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $exe, $true)
$z.Dispose(); Remove-Item $zip -Force
Write-Host "完成：$exe"
