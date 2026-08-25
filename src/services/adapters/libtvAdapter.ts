/**
 * libtvAdapter —— LibTV 本地适配器（Seedance 2.0 家族 / 2.5 + MiniMax H3；生成不走管理端的架构例外，见 libtvCli.ts；
 * 同类还有即梦 dreaminaAdapter；Qiji 侧仅按次收手续费，见 thirdPartyFee.ts）。
 *
 * 提交语义：确保项目对应的 LibTV 云端画布存在 → 垫图逐张 `libtv upload` 成资源节点 →
 * `libtv node create <唯一名> -t video … --left <参考图> --run`（CLI 同步阻塞至终态）。
 * `submit()` 不等 CLI 结束：把整条链包成后台 Promise 记入本地任务表并立即返回 taskId，
 * `poll()` 读任务表——与 taskCenter 单例轮询/generationQueue 断连保护的契约完全一致。
 *
 * taskId 编码画布与节点（`libtv|<画布UUID>|<节点名>`）：应用重启后任务表为空，
 * poll 回退为查询同名节点——LibTV 云端生成不随 CLI 进程中断，url 已出即可捞回（对应
 * pendingGens 的「重连原任务」按钮）；尚未出结果则报 lost（稍后再点重连即可）。
 */
import type { ModelAdapter, SubmitResult, PollResult } from "./types";
import type { ModelOption } from "./channelAdapter";
import type { Capability } from "@/contract";
import { registerAdapter } from "./registry";
import { nodeTypesForCapability } from "@/nodes/nodeSpecs";
import { resolveMaterialLocalPathOrThrow, newProbeScope, type ProbeScope } from "@/services/assetRecover";
import {
	libtvCanvasAlive,
	libtvCreateCanvas,
	libtvFindCanvasByName,
	libtvQueryNodeVideoUrl,
	libtvRunVideoNode,
	libtvUploadRef,
	type LibtvSeedanceVariant,
} from "@/services/libtvCli";
import { isLibtvAuthed } from "@/store/libtvStore";
import { getLibtvFeature } from "@/store/connectionStore";
import { MENTION_TAG_RE, TAG_KIND } from "@/lib/shotMaterials";
import { clampDuration } from "@/lib/genParams";
import { precheckThirdPartyFee, chargeThirdPartyFee, THIRD_PARTY_FEE_CREDITS, thirdPartyFeeCredits } from "@/services/thirdPartyFee";

/** 渠道显示名（画布面板「渠道」pill / 二级模型选择的分组名） */
export const LIBTV_CHANNEL = "LibTV";
/** 本地模型 key（也是 adapter key / 模型下拉的 id）；不与 catalog 模型同名即可 */
export const LIBTV_SEEDANCE_KEY = "libtv-seedance-2";
export const LIBTV_SEEDANCE_FAST_KEY = "libtv-seedance-2-fast";
export const LIBTV_SEEDANCE_MINI_KEY = "libtv-seedance-2-mini";
export const LIBTV_SEEDANCE_25_KEY = "libtv-seedance-2-5";
export const LIBTV_MINIMAX_H3_KEY = "libtv-minimax-h3";

/** MiniMax 家族 id（catalog 无此家族时用本地兜底名；服务端将来注册同 id 家族则显示名自动跟随） */
export const MINIMAX_FAMILY_ID = "fam-minimax";

/** 渠道内可选模型清单（key→显示名/CLI 变体/家族归属）；ModelPicker/channelAdapter/画布二级选择/标题栏实名共用。
 *  加新款只改这一处（第107轮规则）；familyId/familyName 供「家族→渠道/线路→模型」三级折叠（H3 非 Seedance 家族）。 */
export const LIBTV_MODEL_CHOICES: {
	id: string; label: string; variantLabel: string; variant: LibtvSeedanceVariant;
	familyId: string; familyName: string;
}[] = (
	[
		{ id: LIBTV_SEEDANCE_KEY, variantLabel: "Seedance 2.0", variant: "seedance2", familyId: "fam-seedance", familyName: "Seedance 2.0" },
		{ id: LIBTV_SEEDANCE_FAST_KEY, variantLabel: "Seedance 2.0 Fast", variant: "seedance2fast", familyId: "fam-seedance", familyName: "Seedance 2.0" },
		{ id: LIBTV_SEEDANCE_MINI_KEY, variantLabel: "Seedance 2.0 Mini", variant: "seedance2mini", familyId: "fam-seedance", familyName: "Seedance 2.0" },
		{ id: LIBTV_SEEDANCE_25_KEY, variantLabel: "Seedance 2.5", variant: "seedance25", familyId: "fam-seedance", familyName: "Seedance 2.0" },
		{ id: LIBTV_MINIMAX_H3_KEY, variantLabel: "Minimax H3", variant: "minimaxH3", familyId: MINIMAX_FAMILY_ID, familyName: "MiniMax" },
	] as { id: string; variantLabel: string; variant: LibtvSeedanceVariant; familyId: string; familyName: string }[]
).map((c) => ({ ...c, label: `${LIBTV_CHANNEL} · ${c.variantLabel}` }));

/** LibTV 模型是否可用（授权 + 管理端未关入口）；模型列表注入的守卫 */
export function libtvModelAvailable(): boolean {
	return isLibtvAuthed() && getLibtvFeature();
}

/** 注入模型下拉的选项（cap=video 且可用时全清单，否则空）；channelAdapter/ModelPicker 共用。
 *  familyId/familyName 按款自带（H3 归 MiniMax 家族），消费方可用 catalog 家族显示名覆盖 familyName。 */
export function libtvModelOptions(cap: Capability): ModelOption[] {
	if (cap !== "video" || !libtvModelAvailable()) return [];
	return LIBTV_MODEL_CHOICES.map((c) => ({
		id: c.id, label: c.label, channelName: LIBTV_CHANNEL, modelName: c.variantLabel,
		familyId: c.familyId, familyName: c.familyName,
	}));
}

// ── 本地任务表（内存态；重启后 poll 走节点查询回退） ──

interface LocalTask {
	status: "running" | "success" | "failed";
	url?: string;
	error?: string;
}
const tasks = new Map<string, LocalTask>();

const TASK_PREFIX = "libtv|";
function makeTaskId(canvasUuid: string, nodeName: string): string {
	return `${TASK_PREFIX}${canvasUuid}|${nodeName}`;
}
function parseTaskId(taskId: string): { canvasUuid: string; nodeName: string } | null {
	if (!taskId.startsWith(TASK_PREFIX)) return null;
	const rest = taskId.slice(TASK_PREFIX.length);
	const i = rest.indexOf("|");
	if (i <= 0) return null;
	return { canvasUuid: rest.slice(0, i), nodeName: rest.slice(i + 1) };
}

/** Seedance 2.0（star-video2）允许的档位（CLI schema 抽样）；越界收敛到就近可用值 */
const SEEDANCE_RATIOS = new Set(["adaptive", "16:9", "4:3", "1:1", "3:4", "9:16", "21:9"]);
function clampRatio(v: unknown): string {
	const s = String(v ?? "16:9");
	return SEEDANCE_RATIOS.has(s) ? s : "16:9";
}
// 实测 star-video2 schema：resolution 支持 480p/720p/1080p/4k（文档抽样只写了两档，勿回退）
const SEEDANCE_RESOLUTIONS = new Set(["480p", "720p", "1080p", "4k"]);
function clampResolution(v: unknown): string {
	const s = String(v ?? "720p").toLowerCase();
	return SEEDANCE_RESOLUTIONS.has(s) ? s : "720p";
}

/** 比例档（各款 schema 一致：adaptive + 六档） */
const LIBTV_RATIOS = ["adaptive", "16:9", "9:16", "1:1", "4:3", "3:4", "21:9"] as const;

/** 按款的参数档位与素材上限（2026-08-22 实测 `libtv model <modelKey>` schema，CLI 1.1.3）。
 *  legacyClamp=true 的两款沿用历史收敛（clampRatio/clampResolution/clampDuration，用户定稿保留分毫不动）；
 *  其余为新款，遵守 §9「请求参数绝不静默改写」：缺省补该款默认值，非法值原样发出由 CLI/上游明确报错。 */
interface LibtvVariantSpec {
	durMin: number;
	durMax: number;
	durDefault: number;
	resolutions: string[];
	resDefault: string;
	/** mixed2video 各模态上限（schema mixed2videoConfig） */
	refs: { image: number; video: number; audio: number };
	legacyClamp: boolean;
}
const VARIANT_SPECS: Record<LibtvSeedanceVariant, LibtvVariantSpec> = {
	seedance2: {
		durMin: 4, durMax: 15, durDefault: 5,
		resolutions: ["480p", "720p", "1080p", "4k"], resDefault: "720p",
		refs: { image: 9, video: 3, audio: 3 }, legacyClamp: true,
	},
	// ⚠ Fast schema 只有 480p/720p（2026-08-22 实拉；此前下拉多列的 1080p/4k 发上去会被 CLI 拒单）
	seedance2fast: {
		durMin: 4, durMax: 15, durDefault: 5,
		resolutions: ["480p", "720p"], resDefault: "720p",
		refs: { image: 9, video: 3, audio: 3 }, legacyClamp: true,
	},
	seedance2mini: {
		durMin: 4, durMax: 15, durDefault: 5,
		resolutions: ["480p", "720p"], resDefault: "720p",
		refs: { image: 9, video: 3, audio: 3 }, legacyClamp: false,
	},
	// Seedance 2.5：时长到 30s、素材大幅放宽（图30/视10/音10，总≤50），无 4k 档
	seedance25: {
		durMin: 4, durMax: 30, durDefault: 5,
		resolutions: ["480p", "720p", "1080p"], resDefault: "720p",
		refs: { image: 30, video: 10, audio: 10 }, legacyClamp: false,
	},
	// MiniMax H3：分辨率 768P/2K（默认 2K）、时长 5-15、无 enableSound
	minimaxH3: {
		durMin: 5, durMax: 15, durDefault: 5,
		resolutions: ["768P", "2K"], resDefault: "2K",
		refs: { image: 9, video: 3, audio: 3 }, legacyClamp: false,
	},
};

/** 新款参数：缺省补该款默认值，其余原样透传（§9 不夹钳） */
function passthruParams(params: Record<string, unknown>, spec: LibtvVariantSpec): { ratio: string; resolution: string; duration: number } {
	const dur = Number(params.duration);
	return {
		ratio: String(params.aspect_ratio ?? params.ratio ?? "16:9"),
		resolution: String(params.resolution ?? spec.resDefault),
		duration: Number.isFinite(dur) ? dur : spec.durDefault,
	};
}

/** 一条待上传的参考素材（图/视频/音频） */
interface LibtvRef {
	url: string;
	name?: string;
	type: "image" | "video" | "audio";
	/** 提示词里的胶囊引用（"@Image1"…；编号=各自数组的原始位置，与 materialTags 对齐）。
	 *  上传成功后替换为 LibTV 的 `{{Node "<资源节点名>"}}` 引用；首帧等补充素材无 tag。 */
	tag?: string;
}

/** 从 submit input 收集三种模态的参考素材，按该款 schema 上限截断（超出丢弃并 warn）。
 *  tag 按**原始数组位置**编号（空 url 也占号），保证与提示词里的 @ImageN 对齐。 */
function collectRefs(rawInputs: Record<string, unknown>, REF_LIMITS: LibtvVariantSpec["refs"]): LibtvRef[] {
	const pick = (v: unknown, type: LibtvRef["type"]): LibtvRef[] => {
		const arr = (Array.isArray(v) ? v : []) as { url?: string; name?: string }[];
		const refs = arr
			.map((r, i) => ({ url: String(r?.url ?? ""), name: r?.name, type, tag: `@${TAG_KIND[type]}${i + 1}` }))
			.filter((r) => !!r.url);
		if (refs.length > REF_LIMITS[type]) {
			console.warn(`[libtv] ${type} 参考超上限 ${REF_LIMITS[type]}，丢弃 ${refs.length - REF_LIMITS[type]} 条`);
		}
		return refs.slice(0, REF_LIMITS[type]);
	};
	return [
		...pick(rawInputs.images, "image"),
		...pick(rawInputs.videos, "video"),
		...pick(rawInputs.audios, "audio"),
	];
}

/** 确保当前项目有一张可用的 LibTV 云端画布；uuid 随项目文件持久化。
 *  解析顺序：本地记录的 uuid（校验可达）→ 云端按名字复用同名画布（本地 uuid 丢失/历史创建
 *  成功但未记下 uuid 的自愈，避免重复建画布）→ 新建。 */
async function ensureProjectCanvas(): Promise<string> {
	const ps = (await import("@/store/projectStore")).useProjectStore.getState();
	const existing = ps.libtvCanvasUuid;
	if (existing && (await libtvCanvasAlive(existing))) return existing;
	const name = `Qiji-${ps.name || "未命名项目"}`.slice(0, 50);
	const uuid = (await libtvFindCanvasByName(name)) || (await libtvCreateCanvas(name));
	(await import("@/store/projectStore")).useProjectStore.getState().setLibtvCanvasUuid(uuid);
	return uuid;
}

/** 把一个素材 url/uri 解析成本地文件路径：每次提交都探活（换链/死链自愈）→ 校验本地文件仍在 →
 *  必要时落地一份。取不到=明确报错整单拒（见 services/assetRecover，三家第三方渠道共用）。 */
async function resolveLocalPath(uri: string, name: string | undefined, scope: ProbeScope): Promise<string> {
	return resolveMaterialLocalPathOrThrow(uri, "LibTV", { name, scope });
}

/** 后台执行整条生成链，结果写入本地任务表 */
async function runGeneration(
	taskId: string,
	canvasUuid: string,
	nodeName: string,
	prompt: string,
	refs: LibtvRef[],
	params: Record<string, unknown>,
	variant: LibtvSeedanceVariant,
): Promise<void> {
	try {
		// 1) 参考素材（图/视频/音频）逐条上传为资源节点。
		//    ⚠ 取不到本地文件=**明确报错整单拒**（第254轮用户定，勿回退成静默跳过）：
		//    @ImageN 按素材顺序编号，丢一条会让后面全部引用错位（§9A 第118轮）。
		//    资源节点名带 tag 编号（-img1/-vid1/-aud1；无 tag 的补充素材如首帧用 -x1），稳定可反查。
		const refNodeNames: string[] = [];
		const tagMap: Record<string, string> = {}; // "@Image1" → `{{Node "<资源节点名>"}}`
		const kindTag = { image: "img", video: "vid", audio: "aud" } as const;
		let extraSeq = 0;
		const scope = newProbeScope(); // 本次提交内同一素材只探活一次
		for (const ref of refs) {
			const path = await resolveLocalPath(ref.url, ref.name, scope);
			const refName = ref.tag
				? `${nodeName}-${kindTag[ref.type]}${ref.tag.replace(/\D/g, "")}`
				: `${nodeName}-x${++extraSeq}`;
			await libtvUploadRef(canvasUuid, refName, path, ref.type);
			refNodeNames.push(refName);
			if (ref.tag) tagMap[ref.tag] = `{{Node "${refName}"}}`;
		}
		// 提示词胶囊引用 → LibTV 引用：@ImageN/@VideoN/@AudioN 换成对应资源节点的 {{Node "名"}}
		//（CLI 按连线校验并落库为真实引用）；未上传成功/被截断的 tag 移除（留着会被 CLI 拒单）。
		const finalPrompt = prompt.replace(MENTION_TAG_RE, (t) => tagMap[t] ?? "");
		// 2) 建节点 + --run（同步阻塞至终态，CLI 自己轮询写回）。
		//    参数按变体分派：存量两款（2.0 / 2.0 Fast）沿用历史收敛；新款不夹钳（缺省补默认，非法值上游明确报错）
		const spec = VARIANT_SPECS[variant];
		const gen = !spec.legacyClamp
			? passthruParams(params, spec)
			: {
				ratio: clampRatio(params.aspect_ratio ?? params.ratio),
				resolution: clampResolution(params.resolution),
				duration: clampDuration(params.duration),
			};
		const url = await libtvRunVideoNode({
			canvasUuid,
			nodeName,
			prompt: finalPrompt,
			...gen,
			refNodeNames,
			variant,
		});
		tasks.set(taskId, { status: "success", url });
		// 第三方调用成功（--run 同步跑完出片，CLI 无受理中间态）→ 扣 Qiji 手续费（best-effort）
		void chargeThirdPartyFee("LibTV");
	} catch (e) {
		tasks.set(taskId, { status: "failed", error: e instanceof Error ? e.message : "LibTV 生成失败" });
	}
}

/** 按渠道清单条目产出一个 LibTV 适配器（全部款式共用提交/轮询逻辑）。
 *  参数表单/素材上限按各款第三方 schema（见 VARIANT_SPECS），加款只改 LIBTV_MODEL_CHOICES 与该表。 */
function makeLibtvAdapter(key: string, label: string, variantLabel: string, variant: LibtvSeedanceVariant): ModelAdapter {
	const spec = VARIANT_SPECS[variant];
	return {
	key,
	displayName: label,
	vendor: LIBTV_CHANNEL,
	nodeTypes: nodeTypesForCapability("video"),
	// 参数表单以 mode.paramsSchema 为准（第三方渠道：覆盖节点 spec 固定参数，见面板 paramsFromMode）
	paramsFromMode: true,
	modes: [
		{
			key,
			label: variantLabel,
			inputHint: `根据提示词生成视频（走本机 LibTV 授权，Qiji 按次收手续费，见积分预估）`,
			paramsSchema: [
				{ key: "duration", label: "时长", type: "number", min: spec.durMin, max: spec.durMax, step: 1, unit: "秒", default: spec.durDefault },
				{ key: "resolution", label: "分辨率", type: "enum", options: [...spec.resolutions], default: spec.resDefault },
				{ key: "aspect_ratio", label: "比例", type: "enum", options: [...LIBTV_RATIOS], default: "16:9" },
			],
		},
	],
	baseCost: THIRD_PARTY_FEE_CREDITS,
	estimateCost: () => thirdPartyFeeCredits(), // Qiji 侧只收手续费；LibTV 侧按其会员/积分体系消耗

	async submit(input, params): Promise<SubmitResult> {
		if (!getLibtvFeature()) throw new Error("LibTV 功能未对当前账号开放");
		if (!isLibtvAuthed()) throw new Error("尚未连接 LibTV：请到「个人中心 → LibTV 授权」登录后重试");
		precheckThirdPartyFee(); // 手续费余额不足直接拒单（不打第三方）

		// prompt：表格视频链路把正文放 variables.prompt；画布/直调可能给 input.prompt。
		// 保留图例与 @ 胶囊原文——runGeneration 上传后把 @ 胶囊换成 LibTV 的 {{Node}} 引用
		//（图例转换后即「哪条参考是谁」的说明，随单发给模型）。
		const vars = input.variables as Record<string, string> | undefined;
		const prompt = String(vars?.prompt ?? input.prompt ?? "").trim();
		if (!prompt) throw new Error("缺少视频提示词");

		// 参考素材：图/视频/音频三种模态全收（上限按款 schema：2.0 系图≤9/视≤3/音≤3；2.5 图≤30/视≤10/音≤10，超限截断）
		const rawInputs = (input.inputs ?? input) as Record<string, unknown>;
		const refs = collectRefs(rawInputs, spec.refs);
		// 首帧续接（params.firstFrameUrl）：作为首位图像参考传入（不丢帧续语义；图像总数仍守上限）
		const firstFrame = String(params.firstFrameUrl ?? "");
		if (firstFrame && !refs.some((r) => r.url === firstFrame)) {
			refs.unshift({ url: firstFrame, name: "首帧", type: "image" });
			let imgCount = 0;
			for (let i = 0; i < refs.length; i++) {
				if (refs[i].type !== "image") continue;
				if (++imgCount > spec.refs.image) { refs.splice(i, 1); i--; imgCount--; }
			}
		}

		const canvasUuid = await ensureProjectCanvas();
		const nodeName = `qiji-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
		const taskId = makeTaskId(canvasUuid, nodeName);
		tasks.set(taskId, { status: "running" });
		void runGeneration(taskId, canvasUuid, nodeName, prompt, refs, params, variant);
		return { taskId };
	},

	async poll(taskId): Promise<PollResult> {
		const t = tasks.get(taskId);
		if (t) {
			if (t.status === "success") return { status: "success", progress: 100, resultUri: t.url };
			if (t.status === "failed") return { status: "failed", progress: 100, error: t.error || "LibTV 生成失败" };
			return { status: "running", progress: 50 };
		}
		// 应用重启后任务表为空：查询同名节点捞结果（LibTV 云端生成不随本机进程中断）
		const parsed = parseTaskId(taskId);
		if (!parsed) return { status: "failed", progress: 100, error: "无效的 LibTV 任务标识" };
		const url = await libtvQueryNodeVideoUrl(parsed.canvasUuid, parsed.nodeName);
		if (url) return { status: "success", progress: 100, resultUri: url };
		return {
			status: "lost",
			progress: 100,
			error: "本机生成进程已中断，LibTV 云端可能仍在生成。稍后点「重连原任务」找回，或到 LibTV 网页端画布查看。",
		};
	},
	};
}

/** 渠道内各款模型的适配器（key=清单 id） */
export const libtvAdapters: ModelAdapter[] = LIBTV_MODEL_CHOICES.map((c) =>
	makeLibtvAdapter(c.id, c.label, c.variantLabel, c.variant),
);

/** App 启动时注册（一次即可；不依赖 catalog，key 不会被 syncManagedAdapters 覆盖） */
export function registerLibtvAdapter(): void {
	for (const a of libtvAdapters) registerAdapter(a);
}
