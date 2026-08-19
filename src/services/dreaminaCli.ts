/**
 * dreaminaCli —— 即梦（Dreamina）官方 CLI（随包内置 src-tauri/resources/dreamina/dreamina.exe）的调用封装。
 *
 * 架构例外（与 LibTV 同类）：即梦链路走**用户自己的即梦账号**——不经管理端、不扣 Qiji 积分；
 * 管理端仅通过 User.features.dreamina 控制入口显隐。
 * 与 LibTV 的差异（勿混淆）：
 *  - 凭据**共用全局 `~/.dreamina_cli`**（CLI 无凭据目录环境变量，实测重定向 USERPROFILE 后
 *    credential 仍读全局——用户在终端 `curl -s https://jimeng.jianying.com/cli | bash` 装过并登录即直接可用）；
 *  - 登录是 **OAuth 设备码流**（`login --headless` 出 verification_uri/user_code/device_code →
 *    浏览器授权 → `login checklogin --device_code=…` 轮询收尾），不是浏览器回跳；
 *  - 生成是**异步 submit/query**：`multimodal2video` 上传本地素材后返回 submit_id（gen_status=querying），
 *    `query_result --submit_id` 轮询到 success/fail——submit_id 天然可跨进程续查（重启找回比 LibTV 强）。
 *
 * 输出约定（2026-07-09 真机实测 1.4.10；2026-08-06 内置 CLI 升级 1.4.15——新增 seedance2.5、
 * --video_resolution 变为必填（本封装一直恒发不受影响）、参数改严格校验非法值明确报错）：
 * 子命令 stdout 为 JSON（login 复用态/告警行是中文纯文本，解析一律容错）；
 * 提交成功 `{submit_id, gen_status:"querying", credit_count}`；查询中间态带 queue_info。
 */
import { cliError, parseCliJson, extractVideoUrl, type LibtvCliResult } from "@/services/libtvCli";

const isTauri = (): boolean =>
	typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

export type DreaminaCliResult = LibtvCliResult;

/** 运行 CLI 一次；仅「起不来/超时」抛错，业务失败（退出码非 0）由调用方读 stderr 解读 */
export async function runDreamina(args: string[], timeoutSec = 60): Promise<DreaminaCliResult> {
	if (!isTauri()) throw new Error("即梦功能仅在桌面端可用");
	const { invoke } = await import("@tauri-apps/api/core");
	return await invoke<DreaminaCliResult>("run_dreamina", { args, timeoutSec });
}

/** 用系统默认浏览器打开授权页（设备码登录用；仅 http(s)） */
export async function openExternalUrl(url: string): Promise<void> {
	if (!isTauri()) {
		window.open(url, "_blank");
		return;
	}
	const { invoke } = await import("@tauri-apps/api/core");
	await invoke("open_url", { url });
}

// ── 账户 ──

export interface DreaminaAccount {
	userId: string;
	/** 剩余积分（即梦自己的积分，与 Qiji 积分无关） */
	totalCredit: number;
	/** 会员档位（如 maestro；空=普通） */
	vipLevel: string;
}

/** 查询当前登录账户（`user_credit`）；未登录/未内置 CLI 返回 null（不抛错，供启动静默探测） */
export async function dreaminaAccountInfo(): Promise<DreaminaAccount | null> {
	try {
		const r = await runDreamina(["user_credit"], 30);
		if (r.code !== 0) return null;
		const j = parseCliJson(r.stdout);
		if (!j || j.user_id == null) return null;
		return {
			userId: String(j.user_id),
			totalCredit: Number(j.total_credit ?? 0),
			vipLevel: String(j.vip_level ?? ""),
		};
	} catch {
		return null;
	}
}

// ── OAuth 设备码登录 ──

export interface DreaminaDeviceFlow {
	verificationUri: string;
	userCode: string;
	deviceCode: string;
}

/** 从 headless 输出容错抽设备码材料：JSON 键 → 裸文本 `key: value` 正则（导出仅供单测） */
export function pickDeviceFlow(stdout: string): DreaminaDeviceFlow | null {
	const j = parseCliJson(stdout);
	const grab = (keys: string[]): string => {
		for (const k of keys) {
			const v = j?.[k];
			if (typeof v === "string" && v) return v;
		}
		for (const k of keys) {
			const m = stdout.match(new RegExp(`${k}\\s*[:=]\\s*("?)([^\\s"',]+)\\1`, "i"));
			if (m?.[2]) return m[2];
		}
		return "";
	};
	const verificationUri = grab(["verification_uri", "verification_url", "verificationUri"]);
	const userCode = grab(["user_code", "userCode"]);
	const deviceCode = grab(["device_code", "deviceCode"]);
	if (!verificationUri || !deviceCode) return null;
	return { verificationUri, userCode, deviceCode };
}

/**
 * 发起 headless 登录：本地凭据仍有效 → `{ authed: true }`（CLI 直接复用并退出）；
 * 否则返回设备码材料（由调用方开浏览器 + checklogin 轮询收尾）。
 */
export async function dreaminaLoginHeadless(): Promise<
	{ authed: true } | { authed: false; device: DreaminaDeviceFlow }
> {
	const r = await runDreamina(["login", "--headless"], 60);
	// 复用态输出中文纯文本（实测「已复用当前本地 OAuth 登录态」）；device flow 材料抽不出且退出 0 → 复核账户
	const device = pickDeviceFlow(r.stdout);
	if (device) return { authed: false, device };
	if (r.code === 0 && (await dreaminaAccountInfo())) return { authed: true };
	throw new Error(cliError(r, "即梦登录发起失败（未取得设备码材料）"));
}

/** 轮询一轮 checklogin（CLI 内部 --poll 最多阻塞 pollSec 秒）；true=已登录，false=还没好（继续轮） */
export async function dreaminaCheckLogin(deviceCode: string, pollSec = 30): Promise<boolean> {
	const r = await runDreamina(
		["login", "checklogin", `--device_code=${deviceCode}`, `--poll=${pollSec}`],
		pollSec + 30,
	);
	if (r.code !== 0) return false;
	// 退出 0 不足信（版本差异防御）：以账户可查为准
	return !!(await dreaminaAccountInfo());
}

/** 退出登录：清除本机（全局）凭据 */
export async function dreaminaLogout(): Promise<void> {
	await runDreamina(["logout"], 30).catch(() => undefined);
}

// ── 生成（multimodal2video：Seedance 2.0 家族 / 2.5 全能参考） ──

export interface DreaminaVideoSpec {
	prompt: string;
	/** 本地文件路径（CLI 自动上传）；上限按模型：2.0 家族 图≤9/视≤3/音≤3 且至少一图或一视频，
	 *  seedance2.5 图≤30/视≤10/音≤10 且允许纯音频（守卫在 dreaminaAdapter，这里只透传） */
	imagePaths: string[];
	videoPaths: string[];
	audioPaths: string[];
	duration: number;
	ratio: string;
	resolution: string;
	modelVersion: string;
}

/**
 * 提交全能参考视频任务：阻塞至素材上传完成 + 服务端受理（不等生成），返回 submit_id。
 * 判定按 SKILL 约定：不信退出码，只认 `submit_id` 存在且 `gen_status` 为 querying/success。
 */
export async function dreaminaSubmitVideo(spec: DreaminaVideoSpec): Promise<string> {
	const args = ["multimodal2video"];
	for (const p of spec.imagePaths) args.push("--image", p);
	for (const p of spec.videoPaths) args.push("--video", p);
	for (const p of spec.audioPaths) args.push("--audio", p);
	args.push(
		`--prompt=${spec.prompt}`,
		`--duration=${spec.duration}`,
		`--ratio=${spec.ratio}`,
		`--video_resolution=${spec.resolution}`,
		`--model_version=${spec.modelVersion}`,
		"--poll=0",
	);
	const r = await runDreamina(args, 900); // 素材上传可能较慢，留足时间
	const j = parseCliJson(r.stdout);
	const submitId = String(j?.submit_id ?? "");
	const genStatus = String(j?.gen_status ?? "");
	if (submitId && (genStatus === "querying" || genStatus === "success")) return submitId;
	const failReason = String(j?.fail_reason ?? "");
	throw new Error(failReason || cliError(r, "即梦提交失败"));
}

export interface DreaminaTaskState {
	status: "querying" | "success" | "fail";
	videoUrl?: string;
	failReason?: string;
	/** 排队位置（有则可展示；即梦高峰期队列可达数十万） */
	queueIdx?: number;
}

/** 查询任务当前状态（`query_result`）；CLI 起不来/输出解析不出时抛错（调用方按瞬时失败处理） */
export async function dreaminaQueryTask(submitId: string): Promise<DreaminaTaskState> {
	const r = await runDreamina(["query_result", `--submit_id=${submitId}`], 60);
	const j = parseCliJson(r.stdout);
	if (!j || !j.gen_status) throw new Error(cliError(r, "即梦任务查询失败"));
	const status = String(j.gen_status);
	if (status === "success") {
		const rj = (j.result_json ?? {}) as Record<string, unknown>;
		const videos = (rj.videos ?? []) as { video_url?: string }[];
		const url = String(videos?.[0]?.video_url ?? "") || extractVideoUrl(j);
		return { status: "success", videoUrl: url };
	}
	if (status === "fail") {
		return { status: "fail", failReason: String(j.fail_reason ?? "") };
	}
	const queue = (j.queue_info ?? {}) as Record<string, unknown>;
	const queueIdx = Number(queue.queue_idx);
	return { status: "querying", queueIdx: Number.isFinite(queueIdx) ? queueIdx : undefined };
}
