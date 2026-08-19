---
name: qiji-local-cli-upgrade
description: 升级客户端内置 LibTV/即梦本地 CLI 并接新模型：摸底上游→重跑 fetch→CHOICES 加款（带 familyId）→vitest→重打包。触发词：升级 libtv、更新即梦 CLI、seedance 新款。
---

# LibTV / 即梦 本地 CLI 升级与新模型接入

> 项目根：`E:\Kaifa\Qiji\qiji`（其他设备以实际 clone 位置为准）。下文相对路径均相对该项目根。
> 频率低（约每 20 轮一次），改动面小且集中。上一次先例：第203轮（LibTV +MiniMax H3、即梦 CLI 1.4.10→1.4.15 +Seedance 2.5 / 2.0 Mini）——细节勿整读 CLAUDE.md（502KB 会撑爆上下文），用 Grep 带 head_limit 查「第203轮」「第107轮」「第94轮」。

## 何时使用

- 用户说「升级 libtv / 即梦 CLI」「更新本地 CLI 模型」「看看 Seedance 有没有新版本」「LibTV 上了新模型接一下」。
- LibTV 线上出现新模型（`model search` 可见）或即梦上游 version.json 出了新版本。
- ⚠ 这两条渠道是「生成不走管理端」的架构例外（第94/107轮）——升级**纯客户端改动**，服务端零改动无需部署，但**必须客户端重新打包**（新 CLI 二进制与新模型都随包）。

## 前置检查

1. **两个 CLI 二进制在位**（不入 git；本次实测 libtv.exe 约 58MB、dreamina.exe 约 30MB）。本机 PowerShell 5.1（⚠ 不支持 `&&`，逐条或分号）：
   ```powershell
   Get-ChildItem E:\Kaifa\Qiji\qiji\src-tauri\resources -Recurse -File | Select-Object FullName, Length
   ```
2. **CLI 授权状态**：LibTV 应用内凭据在 `<appData>\com.qiji.canvas\libtv`（Rust 侧 `LIBTV_CONFIG_DIR`，与用户自装 `~/.libtv` 隔离——终端直跑 exe 读的是全局目录，要复用应用授权需先设 `$env:LIBTV_CONFIG_DIR`）；即梦凭据**共用全局 `~/.dreamina_cli`**（CLI 无凭据目录环境变量），终端装过并登录即直接可用。
3. **确认改动范围**：只加新款不升二进制 → 跳过步骤 2；上游 CLI 出新版 → 步骤 2 必做（新款往往依赖新 CLI，如 seedance2.5 依赖 1.4.15）。

## 步骤

### 1. 摸底（上游有什么新东西）

**LibTV**（版本锁定制：fetch 脚本默认 `1.1.1`，换版本走 `$env:LIBTV_CLI_VERSION`）：

```powershell
# 本机 PowerShell 5.1，项目根执行；要复用应用授权先设 LIBTV_CONFIG_DIR
& "src-tauri\resources\libtv\libtv.exe" model search --type video   # 线上模型清单（modelKey/modelName）
& "src-tauri\resources\libtv\libtv.exe" model MiniMax-Hailuo-H3     # 单款 schema 实拉（换成目标 modelKey）
```

schema 里要抄下来的：分辨率档、时长范围、比例档、mixed2video 素材上限、**有没有 `enableSound` 键**（见红线）。

**即梦**（beta 滚动通道，URL 不带版本号；版本以同目录 version.json 为准）：

```bash
# Git Bash（⚠ PS 5.1 里 curl 是 Invoke-WebRequest 别名，勿混用）
curl -s https://lf3-static.bytednsdoc.com/obj/eden-cn/psj_hupthlyk/ljhwZthlaukjlkulzlp/dreamina_cli_beta/version.json
```
```powershell
# PS 5.1 等价写法
Invoke-RestMethod https://lf3-static.bytednsdoc.com/obj/eden-cn/psj_hupthlyk/ljhwZthlaukjlkulzlp/dreamina_cli_beta/version.json
```
```powershell
# 本机内置版本与参数档位实锤（PS 5.1，项目根）
& "src-tauri\resources\dreamina\dreamina.exe" --version
& "src-tauri\resources\dreamina\dreamina.exe" multimodal2video -h   # 各 model_version 档位/素材上限
```

### 2. 删旧 exe 重跑 fetch 脚本（升级二进制）

fetch 脚本幂等「已存在即跳过」——**升级必须先删旧 exe**。本机 PowerShell 5.1，项目根：

```powershell
# LibTV（官方出新版时才升；$env:LIBTV_CLI_VERSION 不设 = 脚本内锁定的 1.1.1）
Remove-Item src-tauri\resources\libtv\libtv.exe
$env:LIBTV_CLI_VERSION = 'x.y.z'
powershell -ExecutionPolicy Bypass -File src-tauri/scripts/fetch-libtv.ps1

# 即梦（滚动通道，重拉即最新）
Remove-Item src-tauri\resources\dreamina\dreamina.exe
powershell -ExecutionPolicy Bypass -File src-tauri/scripts/fetch-dreamina.ps1
```

重跑后 `--version` 实锤实际拿到的版本（即梦滚动通道同一 URL 不同时间拉到不同版本，不实锤=不知道自己升到了什么）。

### 3. CHOICES 加款（单一改动点）

**即梦——只改一处**（第107轮规则）：`src\services\adapters\dreaminaAdapter.ts` 的 `DREAMINA_MODEL_CHOICES` 加 `{ id, variantLabel, modelVersion }`：
- `modelVersion` = CLI `--model_version` 档位串（`multimodal2video -h` 实锤，如 `seedance2.5`），id 不与 catalog 模型同名即可。
- 素材上限按款分派：现有 `REF_LIMITS`（2.0 家族 图9/视3/音3）/ `REF_LIMITS_SD25`（图30/视10/音10）；新款上限不同就加新常量并在 `makeDreaminaAdapter` 分派。
- 入参底线按款分派（2.0 家族须至少一图或一视频；2.5 允许纯音频参考）。
- `paramsSchema` 按 `-h` 实拉档位填（时长 min/max、分辨率 options、比例档）。

**LibTV——改两处**（新款=新 CLI 变体）：
1. `src\services\libtvCli.ts`：`LibtvSeedanceVariant` 联合类型 + `SEEDANCE_VARIANTS` 变体表加条目（`modelKey`/`fallback`/`enableSound`/`nameHit`）。
2. `src\services\adapters\libtvAdapter.ts`：`LIBTV_MODEL_CHOICES` 加 `{ id, variantLabel, variant, familyId, familyName }`，参数表单在 `makeLibtvAdapter` 按变体分派（参照 `isH3` 分支）。

**familyId（红线，见下）**：LibTV 每款自带 familyId（H3=`fam-minimax`）；即梦 CHOICES 目前不带 familyId——`src\services\adapters\channelAdapter.ts`（约 :89）与 `src\components\ModelPicker.tsx`（约 :93）兜底钉 `SEEDANCE_FAMILY_ID`，**只在即梦全系确属 Seedance 家族时成立**；若新款不是 Seedance 家族，必须仿 LibTV 给 CHOICES 加 familyId 并改这两个注入点。客户端家族 id 与服务端 families.json 同 id 时显示名自动跟随（`fam-minimax` 第216轮已在服务端注册）。

`src\services\adapters\localChannels.ts`（两级选择助手）只读 CHOICES 常量，新款自动出现在「渠道→模型」二级下拉，零改动。

### 4. 手续费核实（一般零改动）

`src\services\thirdPartyFee.ts`：每次调用第三方渠道收手续费——兜底 5 积分（`THIRD_PARTY_FEE_CREDITS`），实价 = `catalog.fees.thirdParty`（服务端隐藏模型 `fee-thirdparty` 的 cost，管理端「模型」页可调）。时序：提交前 `precheckThirdPartyFee()` 软校验拒单；第三方调用成功后 `chargeThirdPartyFee()` 真扣（即梦=拿到 submit_id 时；LibTV=`--run` 同步跑完时）。新款经 make*Adapter 工厂自动继承（`baseCost`/`estimateCost`/precheck/charge 全在工厂里），核实无需改。

### 5. vitest + 客户端重新打包

```powershell
# 本机 PowerShell 5.1，项目根（逐条执行，勿用 &&）
npx tsc --noEmit
npx vitest run    # 参考基线 602 passed（以 CLAUDE.md 最新轮次为准）
```
- 相关测试：`src\services\dreaminaCli.test.ts`、`src\services\adapters\localChannels.test.ts`。给新款补断言（第203轮先例：新款在列且 CLI flag 值精确 / 存量款 model_version 锁定 / 新家族独立分组）。
- 客户端重新打包走 **qiji-pack-client-tauri** skill；服务端零改动无需部署。

## 验证

- fetch 后 `--version` 输出 = 目标版本；`multimodal2video -h` 含新款档位。
- `tsc --noEmit` 干净 + vitest 全过（基线 602 + 本轮新增）。
- 真机 QA 清单：新款出现在模型下拉且**家族分组正确**（如 MiniMax 独立组）；小额真单一发（消耗用户自己的第三方账号积分 + Qiji 手续费）；积分预估显示手续费实价。
- 即梦 VIP 专属款（如 2.5）：需 VIP 账号；部分模型首用可能返 `AigcComplianceConfirmationRequired`——先到即梦网页端用该模型完成一次生成。

## 踩坑红线

- ⚠ **本地 CLI 走用户自己的账号、凭据只在本机，不走管理端**——LibTV 凭据在 `<appData>\com.qiji.canvas\libtv`（`LIBTV_CONFIG_DIR` 隔离），即梦共用全局 `~/.dreamina_cli`；管理端仅经 `features.libtv/dreamina` 控制入口显隐，绝不把生成链路改走服务端。
- ⚠ **家族别再统一钉 `fam-seedance`**（第203轮教训）——LibTV 每款自带 familyId（H3=`fam-minimax`）；即梦的 fam-seedance 兜底只在全系 Seedance 时成立，新家族款必须显式带 familyId，否则新家族被吞进 Seedance 分组。
- **加新款只改 CHOICES 清单**（第107轮规则）；LibTV 新变体另需 `libtvCli.ts` 变体表条目——除这两（一）处外不该有第三个注册点。
- **新款不夹钳**（§9「请求参数绝不静默改写」）：缺省补默认值、非法值原样发出由 CLI 明确报错；`clampDreaminaRatio/clampDreaminaResolution/clampRatio/clampResolution` 只服务存量款（用户定稿保留的历史收敛行为，分毫不动），**勿给新款套用、勿给新款新写夹钳**。
- **`enableSound` 按 schema 实拉决定**——H3 schema 无该键，`libtvRunVideoNode` 已按变体表分发（仅 Seedance 系发 `-s enableSound=on`），勿回退成恒发。
- **LibTV `-s model=` 只收名字且名字会漂**——永远按 `modelKey` 定位（`SEEDANCE_VARIANTS`），发命令时经 `resolveSeedanceModelName` 即时反查显示名（第94轮规则）；新条目的 `nameHit` 兜底匹配要写。
- **fetch 脚本幂等「已存在即跳过」**——升级必先删旧 exe，否则脚本静默不更新。
- **即梦是 beta 滚动通道**（URL 无版本号）——版本以同目录 version.json 为准；升级后必须 `--version` + `-h` 实锤实际拿到的版本与档位，勿凭 version.json 假设本地已是新版。
- **二进制不入 git**——换机/首次打包必跑 fetch 脚本（连同 ffmpeg 共三个，见 qiji-pack-client-tauri）。
- ⚠ **绝不整读 `CLAUDE.md`**（502KB）——查历史轮次一律 Grep 带 head_limit。

## 相关文件

| 用途 | 路径 |
|---|---|
| LibTV 适配器（`LIBTV_MODEL_CHOICES` 改动点，每款带 familyId） | `src\services\adapters\libtvAdapter.ts` |
| LibTV CLI 封装（`SEEDANCE_VARIANTS` 变体表 / modelKey 反查） | `src\services\libtvCli.ts` |
| 即梦适配器（`DREAMINA_MODEL_CHOICES` 单一改动点） | `src\services\adapters\dreaminaAdapter.ts` |
| 即梦 CLI 封装（multimodal2video / query_result / 设备码登录） | `src\services\dreaminaCli.ts` |
| 渠道→模型两级选择助手（只读 CHOICES，零改动） | `src\services\adapters\localChannels.ts` |
| 手续费（每次调用 5 积分兜底，实价 catalog.fees.thirdParty） | `src\services\thirdPartyFee.ts` |
| 家族兜底注入点（非 Seedance 新款时要改） | `src\services\adapters\channelAdapter.ts`、`src\components\ModelPicker.tsx` |
| LibTV 拉取脚本（版本锁定，`$env:LIBTV_CLI_VERSION` 换版） | `src-tauri\scripts\fetch-libtv.ps1` |
| 即梦拉取脚本（beta 滚动通道，版本看同目录 version.json） | `src-tauri\scripts\fetch-dreamina.ps1` |
| 内置二进制落位（随 Tauri bundle.resources 进包） | `src-tauri\resources\libtv\`、`src-tauri\resources\dreamina\` |
| 相关测试 | `src\services\dreaminaCli.test.ts`、`src\services\adapters\localChannels.test.ts` |
