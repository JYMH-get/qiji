/**
 * comfyuiAdapter —— 「ComfyUI 直连」第三方本地渠道（与 LibTV/即梦同级的架构例外：生成不经管理端、
 * 客户端直连**用户自己绑定的 ComfyUI 实例（可多台，提交时自动分流——探测各台 /queue 负载派给
 * 最闲的一台、平手轮转，见 comfyuiStore.pickComfyEndpoint；taskId 携带端点 id 供轮询定位）**，
 * 跑与服务端「奇迹云」完全相同的
 * MiniMax H3 工作流 jianyi933（图构建=lib/comfyH3Graph.ts，与服务端 comfyGraph.ts 双拷贝同步）；
 * 不扣生成积分，Qiji 仅按次收手续费，见 thirdPartyFee.ts）。
 *
 * 提交语义：素材逐条解析成本地文件（Tauri）/字节（浏览器 dev）→ POST {base}/upload/image 传进
 * ComfyUI input 目录 → buildH3Graph 组装节点图 → POST {base}/prompt 受理 → taskId=`comfyui|<prompt_id>`，
 * `poll()` 查 GET {base}/history/{prompt_id}，成片 = {base}/view 直链（落地由既有媒体完成链路处理：
 * assetPersist 原生下载绕 CORS 天然可用，本文件不自己写下载）。
 *
 * ⚠ 素材红线（§9A 第118轮「一张都不许静默丢」）：超限（图9/视3/音3）**明确报错绝不截断**、
 * 任一素材取不到本地文件/字节**整单拒**——丢/跳任何一条都会让 @ImageN 图例与 ref_image_N 整体错位。
 * （dreamina 的 warn+截断/跳过是存量行为，勿仿。）
 *
 * 提示词：图例与 @ 胶囊原样保留，仅经 toOfficialTags 把 @ImageN/@VideoN/@AudioN 转写成 H3 官方
 * 引用标签 <Picture N>/<Video N>/<Audio N>（素材传入顺序 = 胶囊编号顺序，@Image1=ref_image_0=<Picture 1>）。
 */
import type { ModelAdapter, SubmitResult, PollResult } from "./types";
import type { ModelOption } from "./channelAdapter";
import type { Capability } from "@/contract";
import { registerAdapter } from "./registry";
import { nodeTypesForCapability } from "@/nodes/nodeSpecs";
import { resolveMaterialLocalPathOrThrow, newProbeScope, type ProbeScope } from "@/services/assetRecover";
import { buildH3Graph, toOfficialTags } from "@/lib/comfyH3Graph";
import { comfyGet, comfyPostJson, comfyUpload } from "@/services/comfyuiClient";
import { comfyEndpointById, enabledComfyEndpoints, isComfyuiBound, pickComfyEndpoint } from "@/store/comfyuiStore";
import { getComfyuiFeature } from "@/store/connectionStore";
import { precheckThirdPartyFee, chargeThirdPartyFee, THIRD_PARTY_FEE_CREDITS, thirdPartyFeeCredits } from "@/services/thirdPartyFee";

const isTauri = (): boolean =>
	typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

/** 渠道显示名（画布面板「渠道」pill / 二级模型选择的分组名） */
export const COMFYUI_CHANNEL = "ComfyUI";
/** 本地模型 key（也是 adapter key / 模型下拉的 id）；不与 catalog 模型同名即可 */
export const COMFYUI_MINIMAX_H3_KEY = "comfyui-minimax-h3";

/** 渠道内可选模型清单（单款 MiniMax H3=jianyi933 工作流）；ModelPicker/channelAdapter/localChannels 共用。
 *  familyId 按款自带（照 libtvAdapter 形态）：归 MiniMax 家族，catalog 有同 id 家族时显示名自动跟随。 */
export const COMFYUI_MODEL_CHOICES: {
	id: string; label: string; variantLabel: string; familyId: string; familyName: string;
}[] = (
	[
		{ id: COMFYUI_MINIMAX_H3_KEY, variantLabel: "MiniMax H3", familyId: "fam-minimax", familyName: "MiniMax" },
	] as { id: string; variantLabel: string; familyId: string; familyName: string }[]
).map((c) => ({ ...c, label: `${COMFYUI_CHANNEL} · ${c.variantLabel}` }));

/** ComfyUI 模型是否可用（已绑定地址 + 管理端未关入口）；模型列表注入的守卫 */
export function comfyuiModelAvailable(): boolean {
	return isComfyuiBound() && getComfyuiFeature();
}

/** 注入模型下拉的选项（cap=video 且可用时才出现）；channelAdapter/ModelPicker 共用。
 *  选项自带 familyId/familyName（channelAdapter 的 locals 映射会取 o.familyId，不吃 SEEDANCE 兜底）。 */
export function comfyuiModelOptions(cap: Capability): ModelOption[] {
	if (cap !== "video" || !comfyuiModelAvailable()) return [];
	return COMFYUI_MODEL_CHOICES.map((c) => ({
		id: c.id, label: c.label, channelName: COMFYUI_CHANNEL, modelName: c.variantLabel,
		familyId: c.familyId, familyName: c.familyName,
	}));
}

const TASK_PREFIX = "comfyui|";
/** 多端点（本轮）：taskId 携带端点 id，轮询才知道去问哪台。形态 `comfyui|<endpointId>|<prompt_id>`；
 *  第250轮单端点旧任务是 `comfyui|<prompt_id>`（无端点段）→ 轮询回退第一台启用端点（尽力找回）。 */
function makeTaskId(endpointId: string, promptId: string): string {
	return `${TASK_PREFIX}${endpointId}|${promptId}`;
}
function parseTaskId(taskId: string): { promptId: string; endpointId?: string } | null {
	if (!taskId.startsWith(TASK_PREFIX)) return null;
	const rest = taskId.slice(TASK_PREFIX.length);
	if (!rest) return null;
	const sep = rest.indexOf("|");
	if (sep < 0) return { promptId: rest }; // 旧格式（第250轮单端点）
	const endpointId = rest.slice(0, sep);
	const promptId = rest.slice(sep + 1);
	return promptId ? { promptId, endpointId } : null;
}

/** 一条参考素材（图/视频/音频） */
export interface ComfyRef {
	url: string;
	name?: string;
	type: "image" | "video" | "audio";
}

/** 各模态上限（=jianyi933 工作流/H3 的 图9/视3/音3，与 buildH3Graph 断言同尺） */
export const COMFY_REF_LIMITS = { image: 9, video: 3, audio: 3 } as const;
const LIMIT_LABEL = { image: "图片素材最多 9 张", video: "视频素材最多 3 条", audio: "音频素材最多 3 条" } as const;

/**
 * 从 submit input 收集三种模态的参考素材（保序，编号=图例约定）。
 * ⚠ 超限**明确报错绝不截断丢弃**（§9A 第118轮：丢一张=@ImageN 图例整段错位）。
 * 纯函数可单测（导出供 comfyH3Graph.test.ts 复用断言）。
 */
export function collectComfyRefs(rawInputs: Record<string, unknown>): { images: ComfyRef[]; videos: ComfyRef[]; audios: ComfyRef[] } {
	const pick = (v: unknown, type: ComfyRef["type"]): ComfyRef[] => {
		const arr = (Array.isArray(v) ? v : []) as { url?: string; name?: string }[];
		const refs = arr
			.map((r) => ({ url: String(r?.url ?? ""), name: r?.name, type }))
			.filter((r) => !!r.url);
		if (refs.length > COMFY_REF_LIMITS[type]) {
			throw new Error(`${LIMIT_LABEL[type]}（当前 ${refs.length} 条），请减少后重试`);
		}
		return refs;
	};
	return {
		images: pick(rawInputs.images, "image"),
		videos: pick(rawInputs.videos, "video"),
		audios: pick(rawInputs.audios, "audio"),
	};
}

/** 把一个素材 url/uri 解析成本地文件路径：每次提交都探活（换链/死链自愈）→ 校验本地文件仍在 →
 *  必要时落地一份。取不到=明确报错整单拒（见 services/assetRecover，三家第三方渠道共用）。 */
async function resolveLocalPath(uri: string, name: string | undefined, scope: ProbeScope): Promise<string> {
	return resolveMaterialLocalPathOrThrow(uri, "ComfyUI", { name, scope });
}

/** 短哈希（djb2 hex 8 位）：上传文件名前缀防同名素材互撞（ComfyUI input 目录扁平） */
function hash8(s: string): string {
	let h = 5381;
	for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
	return h.toString(16).padStart(8, "0");
}

const EXT_FALLBACK = { image: "png", video: "mp4", audio: "mp3" } as const;

/** 上传用文件名：短哈希前缀 + 消毒后的原名（无扩展名按模态补默认，ComfyUI 靠扩展名识别格式） */
function uploadFilename(ref: ComfyRef): string {
	const rawName = (ref.name || ref.url.split(/[?#]/)[0].split(/[\\/]/).pop() || "material").trim();
	let safe = rawName.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^_+|_+$/g, "") || "material";
	if (!/\.[A-Za-z0-9]{2,5}$/.test(safe)) safe = `${safe}.${EXT_FALLBACK[ref.type]}`;
	return `${hash8(ref.url)}-${safe}`.slice(0, 120);
}

/** 读音频字节的真实时长（AudioContext.decodeAudioData）；失败 600s 兜底（LOAD_AUDIO 的 end_time 上限语义） */
async function audioDurationOf(bytes: Uint8Array, label: string): Promise<number> {
	try {
		const AC: typeof AudioContext | undefined =
			(globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext ??
			(globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
		if (!AC) throw new Error("AudioContext 不可用");
		const ctx = new AC();
		try {
			// 拷贝出独立 ArrayBuffer（decodeAudioData 会 detach 传入的 buffer；bytes 可能是文件读取的共享视图）
			const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
			const buf = await ctx.decodeAudioData(ab);
			const d = buf.duration;
			if (Number.isFinite(d) && d > 0) return Math.ceil(d * 100) / 100;
			throw new Error("解码得到无效时长");
		} finally {
			void ctx.close().catch(() => undefined);
		}
	} catch (e) {
		console.warn(`[comfyui] 音频「${label}」时长探测失败，按 600s 兜底：`, e);
		return 600;
	}
}

/** 素材解析+上传的产物：ComfyUI input 目录里的文件名（Loader 节点消费） */
interface UploadedRef {
	file: string;
	/** 音频专用：真实时长（秒） */
	durationSec?: number;
}

/**
 * 解析一条素材并上传进 ComfyUI：Tauri=本地文件路径走 Rust 命令、浏览器 dev=fetch 字节走 FormData。
 * ⚠ 任一环节失败（无本地文件/取不到字节/上传非 2xx）→ throw 整单拒（绝不静默跳过，编号会错位）。
 */
async function uploadRef(baseUrl: string, ref: ComfyRef, scope: ProbeScope): Promise<UploadedRef> {
	const label = ref.name || ref.url;
	const filename = uploadFilename(ref);
	let bytesForAudio: Uint8Array | null = null;
	let result: { status: number; body: unknown };
	if (isTauri()) {
		const path = await resolveLocalPath(ref.url, ref.name ?? label, scope); // 取不到即抛（整单拒）
		if (ref.type === "audio") {
			try {
				const fs = await import("@tauri-apps/plugin-fs");
				bytesForAudio = await fs.readFile(path);
			} catch {
				bytesForAudio = null; // 时长探测失败走 600s 兜底，不影响上传
			}
		}
		result = await comfyUpload(baseUrl, filename, path);
	} else {
		// 浏览器 dev：无本地文件系统，直接取字节（data:/blob:/公网直链均可 fetch；需 ComfyUI 开 CORS）
		let bytes: Uint8Array;
		try {
			const resp = await fetch(ref.url);
			if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
			bytes = new Uint8Array(await resp.arrayBuffer());
		} catch (e) {
			throw new Error(`参考素材「${label}」无法取得字节（${e instanceof Error ? e.message : "下载失败"}），无法上传到 ComfyUI`);
		}
		if (ref.type === "audio") bytesForAudio = bytes;
		result = await comfyUpload(baseUrl, filename, bytes);
	}
	if (result.status < 200 || result.status >= 300) {
		throw new Error(`素材「${label}」上传 ComfyUI 失败（HTTP ${result.status}）`);
	}
	// 消费响应返回的实际落名（overwrite=true 时一般=filename；带 subfolder 时 Loader 需要 "subfolder/name"）
	const body = (result.body ?? {}) as { name?: string; subfolder?: string };
	const name = body.name || filename;
	const file = body.subfolder ? `${body.subfolder}/${name}` : name;
	const out: UploadedRef = { file };
	if (ref.type === "audio") {
		out.durationSec = bytesForAudio ? await audioDurationOf(bytesForAudio, label) : 600;
		if (!bytesForAudio) console.warn(`[comfyui] 音频「${label}」读不到字节，时长按 600s 兜底`);
	}
	return out;
}

/** POST /prompt 的错误体 → 人话（提炼 node_errors 首条；兜底 error.message） */
function promptErrorMessage(status: number, body: unknown): string {
	const b = (body ?? {}) as {
		error?: { message?: string; details?: string };
		node_errors?: Record<string, { class_type?: string; errors?: { message?: string; details?: string }[] }>;
	};
	const nodeErrs = b.node_errors ? Object.values(b.node_errors) : [];
	for (const ne of nodeErrs) {
		const first = ne?.errors?.[0];
		if (first?.message) {
			const where = ne.class_type ? `节点 ${ne.class_type}：` : "";
			return `ComfyUI 拒绝工作流——${where}${first.message}${first.details ? `（${first.details}）` : ""}（多为该实例缺少对应节点/模型，请确认已装好 MiniMax H3 工作流）`;
		}
	}
	if (b.error?.message) {
		return `ComfyUI 提交失败：${b.error.message}${b.error.details ? `（${b.error.details}）` : ""}`;
	}
	return `ComfyUI 提交失败（HTTP ${status}）`;
}

const H3_ADAPTER: ModelAdapter = {
	key: COMFYUI_MINIMAX_H3_KEY,
	displayName: COMFYUI_MODEL_CHOICES[0].label,
	vendor: COMFYUI_CHANNEL,
	nodeTypes: nodeTypesForCapability("video"),
	// 参数表单以 mode.paramsSchema 为准（第三方渠道：覆盖节点 spec 固定参数，见面板 paramsFromMode）
	paramsFromMode: true,
	modes: [
		{
			key: COMFYUI_MINIMAX_H3_KEY,
			label: "MiniMax H3",
			inputHint:
				"走你绑定的 ComfyUI（需装好 MiniMax H3 工作流模型），消耗你自己的算力；绑定多台时自动派给最闲的一台；Qiji 按次收手续费（见积分预估）；支持 图9/视3/音3 参考",
			// 用户自己的卡无计费差 → 时长/分辨率/比例全档开放（枚举与 comfyH3Graph 的映射表一把尺）
			paramsSchema: [
				{ key: "duration", label: "时长", type: "number", min: 4, max: 15, step: 1, unit: "秒", default: 10 },
				{ key: "resolution", label: "分辨率", type: "enum", options: ["480p", "640p", "768p", "1080p"], default: "768p" },
				{ key: "aspect_ratio", label: "比例", type: "enum", options: ["16:9", "9:16", "1:1", "4:3", "3:4", "2:3", "3:2", "21:9"], default: "16:9" },
			],
		},
	],
	baseCost: THIRD_PARTY_FEE_CREDITS,
	estimateCost: () => thirdPartyFeeCredits(), // Qiji 侧只收手续费；算力消耗在用户自己的 ComfyUI 实例

	async submit(input, params): Promise<SubmitResult> {
		// ① 守卫 + 自动分流选端点（多台=并行探测 /queue 负载，派给最闲一台、平手轮转；全部不可达=明确报错）
		if (!getComfyuiFeature()) throw new Error("ComfyUI 直连功能未对当前账号开放");
		if (!isComfyuiBound()) throw new Error("尚未绑定 ComfyUI：请到「个人中心 → ComfyUI 直连」绑定地址后重试");
		precheckThirdPartyFee(); // 手续费余额不足直接拒单（不打第三方）
		const endpoint = await pickComfyEndpoint();
		const base = endpoint.url;

		// ② prompt：表格视频链路把正文放 variables.prompt；画布/直调可能给 input.prompt。
		// 图例与 @ 胶囊原样保留（素材顺序=编号顺序，见顶注）。
		const vars = input.variables as Record<string, string> | undefined;
		let prompt = String(vars?.prompt ?? input.prompt ?? "").trim();
		if (!prompt) throw new Error("缺少视频提示词");

		// ③ 素材收集（超限明确报错绝不截断）
		const rawInputs = (input.inputs ?? input) as Record<string, unknown>;
		const refs = collectComfyRefs(rawInputs);

		// ④ 首帧/故事板（params.firstFrameUrl）：**追加到图片末尾**（与服务端奇迹云同尺；
		// ⚠ 勿学 dreamina 前插——前插会让既有 @ImageN 编号整体错位）+ 提示词补引用说明；追加后复检上限。
		const firstFrame = String(params.firstFrameUrl ?? "");
		if (firstFrame && !refs.images.some((r) => r.url === firstFrame)) {
			refs.images.push({ url: firstFrame, name: "故事板", type: "image" });
			if (refs.images.length > COMFY_REF_LIMITS.image) {
				throw new Error(`带故事板生成时图片素材合计超上限 ${COMFY_REF_LIMITS.image} 张（当前 ${refs.images.length} 张），请减少垫图后重试`);
			}
			prompt = `${prompt}\n<Picture ${refs.images.length}> 是本镜头的整体构图参考`;
		}

		// ⑤ 提示词转写：@ImageN/@VideoN/@AudioN → <Picture N>/<Video N>/<Audio N>（H3 官方标签）
		prompt = toOfficialTags(prompt);

		// ⑥⑦ 素材逐条解析→上传进 ComfyUI input 目录（音频顺带探真实时长）；任一失败整单拒
		const images: { file: string }[] = [];
		const videos: { file: string }[] = [];
		const audios: { file: string; durationSec: number }[] = [];
		const scope = newProbeScope(); // 本次提交内同一素材只探活一次
		for (const r of refs.images) images.push({ file: (await uploadRef(base, r, scope)).file });
		for (const r of refs.videos) videos.push({ file: (await uploadRef(base, r, scope)).file });
		for (const r of refs.audios) {
			const up = await uploadRef(base, r, scope);
			audios.push({ file: up.file, durationSec: up.durationSec ?? 600 });
		}

		// ⑧ 组装节点图（duration/aspect/resolution 显式给了才传，缺省=骨架默认；非法值 graph 层 throw）
		const durRaw = params.duration;
		const graph = buildH3Graph({
			workflow: "jianyi933",
			prompt,
			durationSec: durRaw === undefined || durRaw === null || durRaw === "" ? undefined : (durRaw as number | string),
			aspect: params.aspect_ratio === undefined || params.aspect_ratio === null ? undefined : String(params.aspect_ratio),
			resolution: params.resolution === undefined || params.resolution === null ? undefined : String(params.resolution),
			seed: Math.floor(Math.random() * 0x7fffffff),
			images,
			videos,
			audios,
		});

		// ⑨ 提交 /prompt
		let r: { status: number; body: unknown };
		try {
			r = await comfyPostJson(`${base}/prompt`, {
				prompt: graph,
				client_id: `qiji-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
			});
		} catch (e) {
			throw new Error(`无法连接 ComfyUI「${endpoint.name}」（${e instanceof Error ? e.message : "网络错误"}）——请确认实例已启动、地址可达`);
		}
		const rb = (r.body ?? {}) as { prompt_id?: string };
		if (r.status < 200 || r.status >= 300 || !rb.prompt_id) {
			throw new Error(promptErrorMessage(r.status, r.body));
		}

		// ⑩ 第三方受理成功（prompt_id 已拿到）→ 扣 Qiji 手续费（best-effort，不阻塞出 taskId；时序照 dreamina）
		void chargeThirdPartyFee(COMFYUI_CHANNEL);
		return { taskId: makeTaskId(endpoint.id, rb.prompt_id) };
	},

	async poll(taskId): Promise<PollResult> {
		const parsed = parseTaskId(taskId);
		if (!parsed) return { status: "failed", progress: 100, error: "无效的 ComfyUI 任务标识" };
		const pid = parsed.promptId;
		// 端点定位：新格式按 id（含停用端点——停用只挡新单，旧任务给恢复启用指引）；
		// 旧格式（第250轮单端点）回退第一台启用端点尽力找回
		const ep = parsed.endpointId ? comfyEndpointById(parsed.endpointId) : enabledComfyEndpoints()[0];
		if (!ep) {
			return { status: "lost", progress: 100, error: "该任务所在的 ComfyUI 端点已被解绑，请到个人中心重新绑定该地址后点「重连原任务」找回。" };
		}
		if (!ep.enabled) {
			return { status: "lost", progress: 100, error: `该任务所在的 ComfyUI 端点「${ep.name}」已停用，请到个人中心恢复启用后点「重连原任务」找回。` };
		}
		const base = ep.url;
		let r: { status: number; body: unknown };
		try {
			r = await comfyGet(`${base}/history/${pid}`, { timeoutSecs: 30 });
		} catch (e) {
			console.warn("[comfyui] 查询失败（按进行中重试）：", e);
			return { status: "running", progress: 40 };
		}
		if (r.status < 200 || r.status >= 300) {
			console.warn(`[comfyui] history 响应异常 HTTP ${r.status}（按进行中重试）`);
			return { status: "running", progress: 40 };
		}
		// /history/{id} 返回 { [prompt_id]: entry }；任务还在队列/执行中时为空对象
		const bag = (r.body ?? {}) as Record<string, unknown>;
		const entry = bag[pid] as {
			status?: { status_str?: string; completed?: boolean; messages?: [string, { exception_message?: string }][] };
			outputs?: Record<string, { gifs?: { filename?: string; subfolder?: string; type?: string; format?: string }[] }>;
		} | undefined;
		if (!entry) return { status: "running", progress: 50 };

		const st = entry.status;
		if (st?.status_str === "error") {
			const exec = (st.messages ?? []).find((m) => Array.isArray(m) && m[0] === "execution_error");
			const msg = exec?.[1]?.exception_message;
			return { status: "failed", progress: 100, error: msg ? `ComfyUI 工作流执行失败：${msg}` : "ComfyUI 工作流执行失败" };
		}
		if (st?.completed && st?.status_str === "success") {
			// VHS_VideoCombine 的输出落在 outputs.*.gifs（该节点的历史字段名，mp4 也在这里）
			let picked: { filename?: string; subfolder?: string; type?: string; format?: string } | undefined;
			for (const out of Object.values(entry.outputs ?? {})) {
				const gifs = out?.gifs ?? [];
				picked ??= gifs[0];
				const mp4 = gifs.find((g) => (g.format ?? "").includes("mp4") || (g.filename ?? "").toLowerCase().endsWith(".mp4"));
				if (mp4) { picked = mp4; break; }
			}
			if (!picked?.filename) {
				return { status: "failed", progress: 100, error: "ComfyUI 生成完成但未找到视频输出（工作流输出节点被改动？）" };
			}
			const q = new URLSearchParams({ filename: picked.filename, subfolder: picked.subfolder ?? "", type: picked.type ?? "output" });
			// resultUri 的落地（下载/转存）由既有媒体完成链路处理（assetPersist 原生下载绕 CORS）
			return { status: "success", progress: 100, resultUri: `${base}/view?${q.toString()}` };
		}
		return { status: "running", progress: 60 };
	},
};

/** 渠道内各款模型的适配器（当前单款 MiniMax H3） */
export const comfyuiAdapters: ModelAdapter[] = [H3_ADAPTER];

/** App 启动时注册（一次即可；不依赖 catalog，key 不会被 syncManagedAdapters 覆盖） */
export function registerComfyuiAdapter(): void {
	for (const a of comfyuiAdapters) registerAdapter(a);
}
