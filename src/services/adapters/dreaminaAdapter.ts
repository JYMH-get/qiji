/**
 * dreaminaAdapter —— 即梦 · Seedance 家族（2.0 全系 + 2.5）本地适配器（与 LibTV 同类的架构例外：生成不走管理端、
 * 走用户自己的即梦账号；Qiji 侧仅按次收手续费，见 thirdPartyFee.ts；CLI 语义见 dreaminaCli.ts 顶注）。
 *
 * 提交语义：垫素材（图/视频/音频）解析成本地文件路径 → `dreamina multimodal2video`
 * （CLI 自动上传素材后向服务端受理，**阻塞至返回 submit_id**，不等生成）→
 * taskId = `dreamina|<submit_id>`，`poll()` 直接 `query_result` 查服务端。
 *
 * 断连恢复天然成立：submit_id 是服务端任务号，应用重启后凭原 taskId 继续 query 即可
 * （比 LibTV 的「查同名节点」更强，无 lost 中间态——除非 CLI 不可用/登录失效）。
 *
 * 提示词原样发送（含【素材图例】与 @ImageN 胶囊）：即梦全能参考按素材顺序理解引用，
 * 与简梦/服务端视频链路的图例约定同源；素材传入顺序 = 胶囊编号顺序（collectRefs 保序）。
 */
import type { ModelAdapter, SubmitResult, PollResult } from "./types";
import type { ModelOption } from "./channelAdapter";
import type { Capability } from "@/contract";
import { registerAdapter } from "./registry";
import { nodeTypesForCapability } from "@/nodes/nodeSpecs";
import { dreaminaQueryTask, dreaminaSubmitVideo } from "@/services/dreaminaCli";
import { isDreaminaAuthed } from "@/store/dreaminaStore";
import { getDreaminaFeature } from "@/store/connectionStore";
import { clampDuration } from "@/lib/genParams";
import { precheckThirdPartyFee, chargeThirdPartyFee, THIRD_PARTY_FEE_CREDITS, thirdPartyFeeCredits } from "@/services/thirdPartyFee";

/** 渠道显示名（画布面板「渠道」pill / 二级模型选择的分组名） */
export const DREAMINA_CHANNEL = "即梦";
/** 本地模型 key（也是 adapter key / 模型下拉的 id）；不与 catalog 模型同名即可 */
export const DREAMINA_SEEDANCE_KEY = "dreamina-seedance-2";
export const DREAMINA_SEEDANCE_FAST_KEY = "dreamina-seedance-2-fast";

/** 渠道内可选模型清单（第107轮用户定四款 + 第203轮加 Seedance 2.0 Mini / 2.5）：每款固定 CLI model_version（不再开放「版本」参数）。
 *  ModelPicker/channelAdapter/画布二级选择/标题栏实名共用；加新款只改这一处。
 *  Seedance 2.5 = CLI 1.4.15（2026-08-01）新增，即梦侧 VIP 专属：时长 4-30s、480p/720p、
 *  素材上限 图30/视10/音10（总≤50）、允许纯音频参考（参考音视频单条与合计 2-30s）。 */
export const DREAMINA_MODEL_CHOICES: { id: string; label: string; variantLabel: string; modelVersion: string }[] = [
	{ id: DREAMINA_SEEDANCE_KEY, variantLabel: "Seedance 2.0", modelVersion: "seedance2.0" },
	{ id: DREAMINA_SEEDANCE_FAST_KEY, variantLabel: "Seedance 2.0 Fast", modelVersion: "seedance2.0fast" },
	{ id: "dreamina-seedance-2-vip", variantLabel: "Seedance 2.0 VIP", modelVersion: "seedance2.0_vip" },
	{ id: "dreamina-seedance-2-fast-vip", variantLabel: "Seedance 2.0 Fast VIP", modelVersion: "seedance2.0fast_vip" },
	{ id: "dreamina-seedance-2-mini", variantLabel: "Seedance 2.0 Mini", modelVersion: "seedance2.0mini" },
	{ id: "dreamina-seedance-2-5", variantLabel: "Seedance 2.5", modelVersion: "seedance2.5" },
].map((c) => ({ ...c, label: `${DREAMINA_CHANNEL} · ${c.variantLabel}` }));

/** 即梦模型是否可用（授权 + 管理端未关入口）；模型列表注入的守卫 */
export function dreaminaModelAvailable(): boolean {
	return isDreaminaAuthed() && getDreaminaFeature();
}

/** 注入模型下拉的选项（cap=video 且可用时全家族，否则空）；channelAdapter/ModelPicker 共用 */
export function dreaminaModelOptions(cap: Capability): ModelOption[] {
	if (cap !== "video" || !dreaminaModelAvailable()) return [];
	return DREAMINA_MODEL_CHOICES.map((c) => ({ id: c.id, label: c.label, channelName: DREAMINA_CHANNEL, modelName: c.variantLabel }));
}

const TASK_PREFIX = "dreamina|";
function makeTaskId(submitId: string): string {
	return `${TASK_PREFIX}${submitId}`;
}
function parseTaskId(taskId: string): string | null {
	if (!taskId.startsWith(TASK_PREFIX)) return null;
	return taskId.slice(TASK_PREFIX.length) || null;
}

// ── 参数收敛（multimodal2video -h 实测档位：2026-07-09 v1.4.10 存量款 / 2026-08-06 v1.4.15 加 seedance2.5） ──

const DREAMINA_RATIOS = new Set(["1:1", "3:4", "16:9", "4:3", "9:16", "21:9"]);
export function clampDreaminaRatio(v: unknown): string {
	const s = String(v ?? "16:9");
	return DREAMINA_RATIOS.has(s) ? s : "16:9";
}

/** 分辨率按版本收敛（存量四款的历史行为）：仅 seedance2.0_vip 支持 1080p/4k，其余一律 720p（CLI 会拒单，提交前收敛）。
 *  ⚠ seedance2.5 不走本函数——新款遵守 §9「请求参数绝不静默改写」，见 makeDreaminaAdapter 内的分派。 */
export function clampDreaminaResolution(v: unknown, modelVersion: string): string {
	const s = String(v ?? "720p").toLowerCase();
	if (modelVersion !== "seedance2.0_vip") return "720p";
	return new Set(["720p", "1080p", "4k"]).has(s) ? s : "720p";
}

/** 一条参考素材（图/视频/音频） */
interface DreaminaRef {
	url: string;
	name?: string;
	type: "image" | "video" | "audio";
}

/** multimodal2video 各模态上限（CLI -h）：2.0 家族 image<=9, video<=3, audio<=3 且至少一图或一视频；
 *  seedance2.5 image<=30, video<=10, audio<=10（总≤50）且允许纯音频参考 */
interface DreaminaRefLimits { image: number; video: number; audio: number }
const REF_LIMITS: DreaminaRefLimits = { image: 9, video: 3, audio: 3 };
const REF_LIMITS_SD25: DreaminaRefLimits = { image: 30, video: 10, audio: 10 };

/** 从 submit input 收集三种模态的参考素材，按上限截断（超出丢弃并 warn），**保序**（编号=图例约定） */
function collectRefs(rawInputs: Record<string, unknown>, limits: DreaminaRefLimits): DreaminaRef[] {
	const pick = (v: unknown, type: DreaminaRef["type"]): DreaminaRef[] => {
		const arr = (Array.isArray(v) ? v : []) as { url?: string; name?: string }[];
		const refs = arr
			.map((r) => ({ url: String(r?.url ?? ""), name: r?.name, type }))
			.filter((r) => !!r.url);
		if (refs.length > limits[type]) {
			console.warn(`[dreamina] ${type} 参考超上限 ${limits[type]}，丢弃 ${refs.length - limits[type]} 条`);
		}
		return refs.slice(0, limits[type]);
	};
	return [
		...pick(rawInputs.images, "image"),
		...pick(rawInputs.videos, "video"),
		...pick(rawInputs.audios, "audio"),
	];
}

/** 把一个素材 url/uri 解析成本地文件路径（三元映射优先，缺则落地一份）；CLI 只收本地路径 */
async function resolveLocalPath(uri: string, name?: string): Promise<string> {
	const { useProjectStore } = await import("@/store/projectStore");
	const blob = useProjectStore.getState().blobByUri(uri);
	if (blob?.localPath) return blob.localPath;
	const { ensureLocalOriginal } = await import("@/services/assetPersist");
	const saved = await ensureLocalOriginal(uri, { name });
	return saved?.localPath || "";
}

/** 按渠道清单条目产出一个即梦适配器：model_version 由所选模型固定；
 *  参数表单按第三方要求——2.0 家族：duration 4-15/比例 6 档/分辨率仅 VIP 档开放 1080p/4k（其余恒 720p 不出参数）；
 *  seedance2.5：duration 4-30、分辨率 480p/720p、比例同 6 档。 */
function makeDreaminaAdapter(choice: (typeof DREAMINA_MODEL_CHOICES)[number]): ModelAdapter {
	const isVip = choice.modelVersion === "seedance2.0_vip";
	const is25 = choice.modelVersion === "seedance2.5";
	const refLimits = is25 ? REF_LIMITS_SD25 : REF_LIMITS;
	return {
	key: choice.id,
	displayName: choice.label,
	vendor: DREAMINA_CHANNEL,
	nodeTypes: nodeTypesForCapability("video"),
	// 参数表单以 mode.paramsSchema 为准（第三方渠道：覆盖节点 spec 固定参数，见面板 paramsFromMode）
	paramsFromMode: true,
	modes: [
		{
			key: choice.id,
			label: choice.variantLabel,
			inputHint: is25
				? `全能参考生成视频（走本机即梦授权，即梦侧 VIP 专属，扣即梦积分 + Qiji 按次手续费（见积分预估）；需至少一条参考素材，支持纯音频参考；参考音视频单条与合计 2-30 秒）`
				: `全能参考生成视频（走本机即梦授权，扣即梦积分 + Qiji 按次手续费（见积分预估）；需至少一张垫图或参考视频）`,
			paramsSchema: [
				{ key: "duration", label: "时长", type: "number", min: 4, max: is25 ? 30 : 15, step: 1, unit: "秒", default: 5 },
				// 分辨率：2.5 = 480p/720p；VIP 档 = 720p/1080p/4k；其余档位上游只收 720p → 不出参数
				...(is25
					? [{ key: "resolution", label: "分辨率", type: "enum" as const, options: ["480p", "720p"], default: "720p" }]
					: isVip
						? [{ key: "resolution", label: "分辨率", type: "enum" as const, options: ["720p", "1080p", "4k"], default: "720p" }]
						: []),
				{ key: "aspect_ratio", label: "比例", type: "enum", options: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"], default: "16:9" },
			],
		},
	],
	baseCost: THIRD_PARTY_FEE_CREDITS,
	estimateCost: () => thirdPartyFeeCredits(), // Qiji 侧只收手续费；即梦积分消耗以其官方计价为准

	async submit(input, params): Promise<SubmitResult> {
		if (!getDreaminaFeature()) throw new Error("即梦功能未对当前账号开放");
		if (!isDreaminaAuthed()) throw new Error("尚未连接即梦：请到「个人中心 → 即梦授权」登录后重试");
		precheckThirdPartyFee(); // 手续费余额不足直接拒单（不打第三方）

		// prompt：表格视频链路把正文放 variables.prompt；画布/直调可能给 input.prompt。
		// 图例与 @ 胶囊原样保留（素材顺序=编号顺序，见顶注）。
		const vars = input.variables as Record<string, string> | undefined;
		const prompt = String(vars?.prompt ?? input.prompt ?? "").trim();
		if (!prompt) throw new Error("缺少视频提示词");

		const rawInputs = (input.inputs ?? input) as Record<string, unknown>;
		const refs = collectRefs(rawInputs, refLimits);
		// 首帧续接（params.firstFrameUrl）：作为首位图像参考传入（图像总数仍守上限）
		const firstFrame = String(params.firstFrameUrl ?? "");
		if (firstFrame && !refs.some((r) => r.url === firstFrame)) {
			refs.unshift({ url: firstFrame, name: "首帧", type: "image" });
			let imgCount = 0;
			for (let i = 0; i < refs.length; i++) {
				if (refs[i].type !== "image") continue;
				if (++imgCount > refLimits.image) { refs.splice(i, 1); i--; imgCount--; }
			}
		}

		// 素材解析成本地路径（CLI 自动上传本地文件；解析不到的跳过，不拖累整单）
		const paths = { image: [] as string[], video: [] as string[], audio: [] as string[] };
		for (const ref of refs) {
			const p = await resolveLocalPath(ref.url, ref.name);
			if (!p) {
				console.warn(`[dreamina] 参考素材无本地文件，跳过：${ref.name || ref.url}`);
				continue;
			}
			paths[ref.type].push(p);
		}
		// 入参底线：2.0 家族须至少一图或一视频；2.5 允许纯音频（但仍须至少一条素材）
		if (is25) {
			if (!paths.image.length && !paths.video.length && !paths.audio.length) {
				throw new Error(refs.length
					? "参考素材均无法取得本地文件，无法提交即梦"
					: "即梦全能参考（Seedance 2.5）需要至少一条参考素材（图/视频/音频均可）");
			}
		} else if (!paths.image.length && !paths.video.length) {
			throw new Error(refs.length
				? "参考素材均无法取得本地文件，无法提交即梦"
				: "即梦全能参考需要至少一张垫图或一段参考视频");
		}

		const modelVersion = choice.modelVersion;
		// 参数按款分派：存量四款沿用历史收敛；2.5 新款遵守 §9 不夹钳——缺省补默认，
		// 非法值原样发出由 CLI 严格校验明确报错（1.4.15 起 CLI 明言 rejected instead of silently adjusted）
		const durRaw = Number(params.duration);
		const submitId = await dreaminaSubmitVideo({
			prompt,
			imagePaths: paths.image,
			videoPaths: paths.video,
			audioPaths: paths.audio,
			duration: is25 ? (Number.isFinite(durRaw) ? durRaw : 5) : clampDuration(params.duration),
			ratio: is25 ? String(params.aspect_ratio ?? params.ratio ?? "16:9") : clampDreaminaRatio(params.aspect_ratio ?? params.ratio),
			resolution: is25 ? String(params.resolution ?? "720p") : clampDreaminaResolution(params.resolution, modelVersion),
			modelVersion,
		});
		// 第三方受理成功（submit_id 已拿到）→ 扣 Qiji 手续费（best-effort，不阻塞出 taskId）
		void chargeThirdPartyFee(DREAMINA_CHANNEL);
		return { taskId: makeTaskId(submitId) };
	},

	async poll(taskId): Promise<PollResult> {
		const submitId = parseTaskId(taskId);
		if (!submitId) return { status: "failed", progress: 100, error: "无效的即梦任务标识" };
		let state;
		try {
			state = await dreaminaQueryTask(submitId);
		} catch (e) {
			// CLI 起不来/输出异常按瞬时失败处理（taskCenter 超时兜底）；登录失效给明确指引
			if (!isDreaminaAuthed()) {
				return { status: "lost", progress: 100, error: "即梦登录状态失效，请到「个人中心 → 即梦授权」重新登录后点「重连原任务」找回。" };
			}
			console.warn("[dreamina] 查询失败（按进行中重试）：", e);
			return { status: "running", progress: 40 };
		}
		if (state.status === "success") {
			if (!state.videoUrl) return { status: "failed", progress: 100, error: "即梦生成完成但未取到视频链接（可到即梦网页端「历史记录」查看）" };
			return { status: "success", progress: 100, resultUri: state.videoUrl };
		}
		if (state.status === "fail") {
			return { status: "failed", progress: 100, error: state.failReason || "即梦生成失败" };
		}
		return { status: "running", progress: 50 };
	},
	};
}

/** 渠道内各款模型的适配器（key=清单 id） */
export const dreaminaAdapters: ModelAdapter[] = DREAMINA_MODEL_CHOICES.map((c) => makeDreaminaAdapter(c));

/** App 启动时注册（一次即可；不依赖 catalog，key 不会被 syncManagedAdapters 覆盖） */
export function registerDreaminaAdapter(): void {
	for (const a of dreaminaAdapters) registerAdapter(a);
}
