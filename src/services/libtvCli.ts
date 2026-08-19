/**
 * libtvCli —— LibTV 官方 CLI（随包内置 src-tauri/resources/libtv/libtv.exe）的调用封装。
 *
 * 架构例外（锁定）：LibTV 链路走**用户自己的 LibTV 账号**——凭据只在本机
 * （Rust 侧 LIBTV_CONFIG_DIR=<appData>/libtv，与用户自装 ~/.libtv 隔离），
 * 不经管理端、不扣 Qiji 积分；管理端仅通过 User.features.libtv 控制入口显隐。
 *
 * CLI 语义要点（详见官方 skill 文档 libtv-cli-skill）：
 *  - 画布（project）是云端实体；节点生成 `libtv node ... --run` 为**同步阻塞**命令，
 *    CLI 自己提交+轮询+写回画布，进程退出时 stdout 输出终态 JSON——外层不要再包轮询。
 *  - 所有子命令显式传 `-p <画布UUID>`，不依赖 cwd 的 .libtv/project.json 状态。
 */
const isTauri = (): boolean =>
	typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

export interface LibtvCliResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** 账户信息（`libtv account info` 摘要）。
 *  ⚠ CLI 1.1.1 不提供积分/灵感值接口（实测 info/list 仅有会员套餐 memberAccount），
 *  故只透出会员信息；后续 CLI 若增积分命令再接。 */
export interface LibtvAccount {
	nickname: string;
	accountName?: string;
	/** 会员套餐名（如「标准版VIP 连续包月」；非会员为空） */
	memberName?: string;
}

/** 运行 CLI 一次；仅「起不来/超时」抛错，业务失败（退出码非 0）由调用方读 stderr 解读 */
export async function runLibtv(args: string[], timeoutSec = 60): Promise<LibtvCliResult> {
	if (!isTauri()) throw new Error("LibTV 功能仅在桌面端可用");
	const { invoke } = await import("@tauri-apps/api/core");
	return await invoke<LibtvCliResult>("run_libtv", { args, timeoutSec });
}

/** 业务失败时的可读错误（stderr 末尾几行；空则给通用文案） */
export function cliError(r: LibtvCliResult, fallback: string): string {
	const tail = (r.stderr || r.stdout || "")
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean)
		.slice(-3)
		.join(" | ");
	return tail || fallback;
}

/**
 * stdout 容错取 JSON：整段 parse → 逐行 parse（NDJSON 取最后一个能解析的对象）→
 * 截取首个 `{…}` 平衡片段。CLI stdout 约定为 JSON，但留容错防版本差异。
 */
export function parseCliJson(stdout: string): Record<string, unknown> | null {
	const s = (stdout || "").trim();
	if (!s) return null;
	try {
		return JSON.parse(s) as Record<string, unknown>;
	} catch { /* 继续 */ }
	// NDJSON：取最后一个可解析行
	const lines = s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
	for (let i = lines.length - 1; i >= 0; i--) {
		try {
			return JSON.parse(lines[i]) as Record<string, unknown>;
		} catch { /* 下一行 */ }
	}
	// 平衡截取首个 {...}
	const start = s.indexOf("{");
	if (start >= 0) {
		let depth = 0;
		for (let i = start; i < s.length; i++) {
			if (s[i] === "{") depth++;
			else if (s[i] === "}") {
				depth--;
				if (depth === 0) {
					try {
						return JSON.parse(s.slice(start, i + 1)) as Record<string, unknown>;
					} catch {
						break;
					}
				}
			}
		}
	}
	return null;
}

/** 深度扫 JSON 里的视频直链（url/videoUrl/video_url/poster 之外的 http(s) .mp4 等）；取最后出现者（最新结果） */
export function extractVideoUrl(obj: unknown): string {
	let found = "";
	const walk = (v: unknown): void => {
		if (typeof v === "string") {
			if (/^https?:\/\//i.test(v) && /\.(mp4|webm|mov)(\?|#|$)/i.test(v)) found = v;
			return;
		}
		if (Array.isArray(v)) {
			for (const x of v) walk(x);
			return;
		}
		if (v && typeof v === "object") {
			for (const [k, x] of Object.entries(v)) {
				// 封面/缩略图字段跳过（poster/cover/thumb）
				if (/poster|cover|thumb/i.test(k)) continue;
				walk(x);
			}
		}
	};
	walk(obj);
	if (found) return found;
	// 兜底：url 类键名下的任意 http(s) 链接
	const walk2 = (v: unknown, key?: string): void => {
		if (typeof v === "string") {
			if (key && /url/i.test(key) && !/poster|cover|thumb/i.test(key) && /^https?:\/\//i.test(v)) found = v;
			return;
		}
		if (Array.isArray(v)) {
			for (const x of v) walk2(x, key);
			return;
		}
		if (v && typeof v === "object") {
			for (const [k, x] of Object.entries(v)) walk2(x, k);
		}
	};
	walk2(obj);
	return found;
}

// ── 授权 ──

/** 查询当前登录账户；未登录/未内置 CLI 返回 null（不抛错，供启动静默探测） */
export async function libtvAccountInfo(): Promise<LibtvAccount | null> {
	try {
		const r = await runLibtv(["account", "info"], 30);
		if (r.code !== 0) return null;
		const j = parseCliJson(r.stdout);
		if (!j) return null;
		const user = (j.user ?? {}) as Record<string, unknown>;
		const active = (j.activeAccount ?? {}) as Record<string, unknown>;
		const member = (active.memberAccount ?? {}) as Record<string, unknown>;
		const nickname = String(user.nickname ?? user.name ?? "") || "LibTV 用户";
		const accountName = String(active.accountName ?? "") || undefined;
		const memberName = member.effective !== false ? String(member.memberName ?? "") || undefined : undefined;
		return { nickname, accountName, memberName };
	} catch {
		return null;
	}
}

/**
 * 浏览器登录：CLI 起本机回跳服务并自动打开浏览器（--open），用户在网页完成登录后
 * 回跳 127.0.0.1 写入凭据、进程退出。阻塞直到完成/超时（5 分钟）。
 */
export async function libtvLoginWeb(): Promise<{ ok: boolean; error?: string }> {
	const r = await runLibtv(["login", "web", "--open"], 300);
	if (r.code === 0) return { ok: true };
	return { ok: false, error: cliError(r, "登录未完成（可能超时或浏览器里未确认）") };
}

/** 退出登录：删除本机凭据 */
export async function libtvLogout(): Promise<void> {
	await runLibtv(["logout"], 30).catch(() => undefined);
}

// ── 画布 / 生成 ──

/** 从 project create/list 的一条画布元数据里取 uuid（create 实测返回嵌套 `{projectMeta:{uuid}}`，容错多形态） */
function pickCanvasUuid(j: Record<string, unknown> | null): string {
	if (!j) return "";
	const meta = (j.projectMeta ?? j) as Record<string, unknown>;
	return String(meta?.uuid ?? meta?.projectUuid ?? j.uuid ?? j.projectUuid ?? "");
}

/** 新建云端画布，返回画布 UUID（-w 0：建在根目录，不落入任何工作区） */
export async function libtvCreateCanvas(name: string): Promise<string> {
	const r = await runLibtv(["project", "create", name, "-w", "0"], 60);
	if (r.code !== 0) throw new Error(cliError(r, "LibTV 画布创建失败"));
	const uuid = pickCanvasUuid(parseCliJson(r.stdout));
	if (!uuid) throw new Error("LibTV 画布创建成功但未取到 UUID");
	return uuid;
}

/** 按名字精确查找已有画布（--name 是子串过滤，这里再做全等匹配）；找不到/失败返回 ""。
 *  用途：创建前先复用同名画布——本地 uuid 丢失或历史创建成功但未记下 uuid 时不再重复建画布。 */
export async function libtvFindCanvasByName(name: string): Promise<string> {
	try {
		const r = await runLibtv(["project", "list", "--name", name, "-s", "50"], 30);
		if (r.code !== 0) return "";
		const j = parseCliJson(r.stdout);
		const list = (j?.projectMetaList ?? j?.projects ?? []) as Record<string, unknown>[];
		if (!Array.isArray(list)) return "";
		const hit = list.find((p) => String(p?.name ?? "") === name);
		return hit ? pickCanvasUuid(hit) : "";
	} catch {
		return "";
	}
}

/** 校验画布仍可访问（换号/画布被删后需重建）；失败返回 false 不抛错 */
export async function libtvCanvasAlive(uuid: string): Promise<boolean> {
	try {
		const r = await runLibtv(["project", uuid], 30);
		return r.code === 0;
	} catch {
		return false;
	}
}

/** 上传本地文件为画布资源节点，返回节点展示名（后续 --left 用名字引用） */
export async function libtvUploadRef(
	canvasUuid: string,
	nodeName: string,
	filePath: string,
	type: "image" | "video" | "audio",
): Promise<string> {
	const r = await runLibtv(
		["upload", nodeName, "-f", filePath, "-t", type, "-p", canvasUuid],
		300, // 上传大文件留足时间
	);
	if (r.code !== 0) throw new Error(cliError(r, "LibTV 素材上传失败"));
	return nodeName;
}

/** 渠道内各款模型的稳定 modelKey（CLI `-s model=` 只收**名字**且名字会漂——实测线上叫
 *  「Seedance 2.0 VIP / Seedance 2.0 Fast VIP / Minimax H3」——故运行时按 key 反查当前实名）。
 *  ⚠ 名字兜底匹配须排除同前缀的别家变体（"Seedance 2.0" 前缀会同时命中 Fast/Mini）。
 *  enableSound：仅 Seedance 系 schema 有该设置键（H3 schema 无，发了可能被拒——2026-08-06 实测对比）。 */
export type LibtvSeedanceVariant = "seedance2" | "seedance2fast" | "minimaxH3";
const SEEDANCE_VARIANTS: Record<LibtvSeedanceVariant, { modelKey: string; fallback: string; enableSound: boolean; nameHit: (n: string) => boolean }> = {
	seedance2: {
		modelKey: "star-video2",
		fallback: "Seedance 2.0 VIP",
		enableSound: true,
		nameHit: (n) => n.startsWith("Seedance 2.0") && !/fast|mini/i.test(n),
	},
	seedance2fast: {
		modelKey: "star-video2-fast",
		fallback: "Seedance 2.0 Fast VIP",
		enableSound: true,
		nameHit: (n) => n.startsWith("Seedance 2.0") && /fast/i.test(n),
	},
	minimaxH3: {
		modelKey: "MiniMax-Hailuo-H3",
		fallback: "Minimax H3",
		enableSound: false,
		nameHit: (n) => /^minimax\s*h3\b/i.test(n),
	},
};
const cachedSeedanceNames = new Map<LibtvSeedanceVariant, string>();

/** 解析 Seedance 2.0（含 Fast 变体）当前的 modelName（`model search --type video` 按 modelKey 命中；会话内缓存） */
export async function resolveSeedanceModelName(variant: LibtvSeedanceVariant = "seedance2"): Promise<string> {
	const cached = cachedSeedanceNames.get(variant);
	if (cached) return cached;
	const v = SEEDANCE_VARIANTS[variant];
	try {
		const r = await runLibtv(["model", "search", "--type", "video"], 30);
		if (r.code === 0) {
			const j = parseCliJson(r.stdout);
			const list = (j?.matches ?? []) as { modelKey?: string; modelName?: string }[];
			if (Array.isArray(list)) {
				const hit =
					list.find((m) => String(m?.modelKey) === v.modelKey) ??
					list.find((m) => v.nameHit(String(m?.modelName ?? "")));
				const name = String(hit?.modelName ?? "");
				if (name) {
					cachedSeedanceNames.set(variant, name);
					return name;
				}
			}
		}
	} catch { /* 回退保底名 */ }
	return v.fallback;
}

export interface LibtvVideoNodeSpec {
	canvasUuid: string;
	nodeName: string;
	prompt: string;
	/** Seedance 2.0 settings（键与 CLI -s 拍平键一致） */
	ratio: string;
	resolution: string;
	duration: number;
	/** 已上传的参考图节点名（≥1 → mixed2video，0 → text2video） */
	refNodeNames: string[];
	/** 模型变体（缺省=Seedance 2.0 基础版；fast=star-video2-fast；minimaxH3=MiniMax-Hailuo-H3） */
	variant?: LibtvSeedanceVariant;
}

/**
 * 新建视频节点并触发生成（`node create … --run`，同步阻塞至终态）。
 * 成功返回视频直链；失败抛错（stderr 摘要）。生成通常数分钟，超时 30 分钟。
 */
export async function libtvRunVideoNode(spec: LibtvVideoNodeSpec): Promise<string> {
	const variant = spec.variant ?? "seedance2";
	const modelName = await resolveSeedanceModelName(variant);
	const args = [
		"node", "create", spec.nodeName,
		"-t", "video",
		"-p", spec.canvasUuid,
		"--prompt", spec.prompt,
		"-s", `model=${modelName}`,
		"-s", `modeType=${spec.refNodeNames.length ? "mixed2video" : "text2video"}`,
		"-s", "count=1",
		"-s", `ratio=${spec.ratio}`,
		"-s", `resolution=${spec.resolution}`,
		"-s", `duration=${spec.duration}`,
	];
	// enableSound 仅 schema 里有该键的变体才发（H3 无此设置）
	if (SEEDANCE_VARIANTS[variant].enableSound) args.push("-s", "enableSound=on");
	for (const n of spec.refNodeNames) args.push("--left", n);
	args.push("--run");
	const r = await runLibtv(args, 1800);
	if (r.code !== 0) throw new Error(cliError(r, "LibTV 生成失败"));
	// 取链接：--run 终态输出（整段/NDJSON 逐行）→ 裸文本正则 → **查节点**（权威兜底：
	// --run 退出码 0 时画布必已写回 data.url，实测节点 JSON 一定有成片链接）
	let url = extractVideoUrl(parseCliJson(r.stdout));
	if (!url) {
		for (const line of r.stdout.split(/\r?\n/)) {
			try {
				url = extractVideoUrl(JSON.parse(line.trim()));
				if (url) break;
			} catch { /* 非 JSON 行跳过 */ }
		}
	}
	if (!url) {
		const m = r.stdout.match(/https?:\/\/[^\s"'\\]+\.(mp4|webm|mov)[^\s"'\\]*/i);
		url = m?.[0] ?? "";
	}
	if (!url) url = await libtvQueryNodeVideoUrl(spec.canvasUuid, spec.nodeName);
	if (!url) throw new Error(`LibTV 生成结束但未取到视频链接（节点「${spec.nodeName}」，可到 LibTV 网页端画布查看）`);
	return url;
}

/**
 * 查询节点当前的视频结果（断连找回：--run 进程随应用关闭而中断，但 LibTV 云端生成仍在继续，
 * 稍后凭同名节点查询即可捞回 url）。无结果返回 ""。
 */
export async function libtvQueryNodeVideoUrl(canvasUuid: string, nodeName: string): Promise<string> {
	const r = await runLibtv(["node", nodeName, "-p", canvasUuid], 60);
	if (r.code !== 0) return "";
	return extractVideoUrl(parseCliJson(r.stdout));
}
