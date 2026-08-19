# 拉取并内置 Windows 版 即梦（Dreamina）CLI（dreamina.exe）到 src-tauri/resources/dreamina/dreamina.exe
# 该二进制随 Tauri 打包进应用（bundle.resources），供「即梦授权 / Seedance 2.0 生成」原生调用。
# ⚠ 官方分发是 beta 滚动通道（URL 不带版本号，curl -s https://jimeng.jianying.com/cli | bash 同源）：
#   https://lf3-static.bytednsdoc.com/obj/eden-cn/psj_hupthlyk/ljhwZthlaukjlkulzlp/dreamina_cli_beta/dreamina_cli_windows_amd64.exe
#   版本以同目录 version.json 为准（接入时为 1.4.10）；升级=删旧 exe 重跑本脚本。
# 体积约 30MB 不入 git，克隆后或换机时运行本脚本一次即可。
#   用法：powershell -ExecutionPolicy Bypass -File src-tauri/scripts/fetch-dreamina.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSCommandPath)   # = src-tauri
$dest = Join-Path $root 'resources\dreamina'
$exe  = Join-Path $dest 'dreamina.exe'
if (Test-Path $exe) { Write-Host "已存在：$exe（删除后重跑可更新）"; exit 0 }
New-Item -ItemType Directory -Force -Path $dest | Out-Null
$url = 'https://lf3-static.bytednsdoc.com/obj/eden-cn/psj_hupthlyk/ljhwZthlaukjlkulzlp/dreamina_cli_beta/dreamina_cli_windows_amd64.exe'
Write-Host "下载 即梦 CLI（beta 通道，约 30MB）…"
Invoke-WebRequest -Uri $url -OutFile $exe -UseBasicParsing
Write-Host "完成：$exe"
