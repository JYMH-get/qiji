/**
 * freeGenActions —— 「自由结果占位」（时间轴空白右键新建、**无 shotRef**）的生成动作：
 * 提交 / 进度回填 / 终态落笔 / 重开客户端后的断连找回。
 *
 * ⚠ 为什么这条链走 [purposeRunner.runPurpose](@/services/purposeRunner) 而不是
 *   [generationQueue](@/services/generationQueue)（选路理由，勿当成"另起管线"）：
 *   - `runPurpose` **就是**库内唯一请求路径（表格按键 / 画布节点 → runPurpose →
 *     taskCenter 集中轮询）。计费、失败退款、请求记录、模式门禁全部挂在它与服务端上，
 *     画布节点（defaultNodeExecute）走的也正是这一条，不是绕路；
 *   - `generationQueue` 是压在 runPurpose 之上的**断连保护层**，它的三种在途目标——
 *     资产（cat/assetId）、分镜（episodeId/shotId）、派生记录（recId）——**都要求结果落在
 *     一个已存在的资产或分镜上**。自由占位两样都没有：把它塞给 startShotGeneration 会走到
 *     `applyShotResult` 找不到分镜 → 结果被静默丢弃，我们连产物 uri 都拿不到。
 *     故这条链自己承担"断连保护"：**在途状态就记在片段自己身上**（status/taskRef，随 rtcDoc
 *     落项目文件），重开后 {@link resumeFreeGens} 凭 taskRef 走 `runPurpose({resumeTask})`
 *     重挂集中轮询（**不重新提交、不再扣费**）——与画布节点把 `{taskId, adapterKey}` 存在
 *     node.data.task 上、启动 resumeCanvasNodeTasks 重挂（第150轮）是同一个范式。
 *   分镜占位（有 shotRef）**照旧**走 generationQueue（有分镜当结果落点），见 shotGenActions/placeholderSwap。
 *
 * ⚠ 其余红线：不拼提示词模板正文；提交前 resolvePresets 展开预设胶囊（第174轮收口点）；
 *   垫素材一条都不许静默丢——取不到公网直链就明确报错且**请求不发出**（@ 编号错位红线）。
 */
import type { Purpose } from "@/contract";
import { useProjectStore } from "@/store/projectStore";
import { useRtcStore } from "@/store/rtcStore";
import { effectiveModelKey } from "@/components/ModelPicker";
import { ensurePublicUrl } from "@/lib/publicUrl";
import { resolvePresets } from "@/lib/presetSchemes";
import { imageResolutionOptionsForKey, videoReqOptionsForKey } from "@/lib/modelOptions";
import { runPurpose } from "@/services/purposeRunner";
import type { TaskExtra } from "@/services/adapters/types";
import type { RtcSegment } from "@/types/rtc";
import {
	AUDIO_GEN_UNSUPPORTED,
	buildFreeImageParams,
	buildFreeInput,
	buildFreeVideoParams,
	genCapabilityFor,
	genPurposeFor,
	packTaskRef,
	parseTaskRef,
	type FreeRefUrl,
	type RtcGenKind,
} from "./rtcGenCore";
import { useRtcFreeGenStore } from "./rtcFreeGenStore";
import {
	armRunning,
	currentOwner,
	landMedia,
	liveSegment,
	markFailed,
	mirrorProgress,
	persistGenAsset,
	probeDurationSec,
} from "./rtcGenSink";

export type FreeGenResult = { ok: true } | { ok: false; error: string };

/** 本会话已挂上轮询的自由占位（segId）——防重复提交/重复重挂（taskCenter 按 taskId 单 handler，双挂会互相顶掉） */
const attached = new Set<string>();

/** 该自由占位此刻是否有生成在跑（按钮禁用用；非 hook） */
export function freeGenBusy(segId: string): boolean {
	return attached.has(segId);
}

/** 片段的产物类型（genKind 优先，回退 media；都没有=当视频） */
export function segGenKind(seg: RtcSegment): RtcGenKind {
	return seg.genKind ?? seg.media ?? "video";
}

/** 结束一次跟踪（成功/失败/放弃都要调，否则按钮永远禁用） */
function detach(segId: string): void {
	attached.delete(segId);
}

/**
 * 提交一次自由占位生成。
 * 组装 → armRunning（占位转「生成中」，进撤销栈）→ runPurpose → 进度回填 → 终态落笔。
 * 返回 `{ok:false, error}` 时**请求没有发出**（调用方 alert 说明，绝不静默失败）。
 */
export async function startFreeGen(segId: string): Promise<FreeGenResult> {
	if (attached.has(segId)) return { ok: false, error: "该占位正在生成中，请等它结束。" };
	const seg = liveSegment(segId);
	if (!seg) return { ok: false, error: "该片段已被删除。" };
	if (seg.kind !== "placeholder") return { ok: false, error: "该片段已经是结果片段，如需新版本请右键「重新生成」。" };

	const kind = segGenKind(seg);
	const purpose = genPurposeFor(kind);
	const cap = genCapabilityFor(kind);
	if (!purpose || !cap) return { ok: false, error: AUDIO_GEN_UNSUPPORTED };

	const draft = useRtcFreeGenStore.getState().draftOf(segId);
	const rawPrompt = (draft.prompt || "").trim();
	if (!rawPrompt) return { ok: false, error: "请先填写提示词——生成需要知道要做什么。" };

	const modelKey = draft.modelKey || effectiveModelKey(cap);
	if (!modelKey) {
		return {
			ok: false,
			error: cap === "video" ? "当前没有可用的视频模型：请检查「设置 → 管理端」连接，或在模型下拉里选一个。" : "当前没有可用的图片模型：请检查「设置 → 管理端」连接，或在模型下拉里选一个。",
		};
	}

	// 出图不吃视频/音频参考 → 前置明确报错（绝不静默丢素材，也不白发一次注定失败的请求）
	if (kind === "image") {
		const bad = draft.refs.find((r) => r.media !== "image");
		if (bad) {
			return { ok: false, error: `图片生成只能用图片垫图，请先移除「${bad.name || "未命名"}」（${bad.media === "video" ? "视频" : "音频"}素材）。` };
		}
	}

	// 垫素材公网化（⚠ 一条都不许静默丢：取不到直链即明确报错、请求不发出）
	const refs: FreeRefUrl[] = [];
	for (const r of draft.refs) {
		const u = await ensurePublicUrl(r.uri, { name: r.name });
		if (!u) {
			return {
				ok: false,
				error: `素材「${r.name || "未命名"}」无法取得公网直链（原文件失效或网络异常）。垫素材与提示词 @ 编号按位对应，缺一条会整体错位——请移除该素材或重新拖入后重试。`,
			};
		}
		refs.push({ url: u, name: r.name, media: r.media });
	}

	const ms = useProjectStore.getState().mediaSettings;
	// 档位一把尺（modelOptions）：catalog 优先、本地渠道（ComfyUI/LibTV/即梦）回退适配器 paramsSchema
	const params =
		kind === "video"
			? buildFreeVideoParams(seg.targetDurationUs, ms, videoReqOptionsForKey(modelKey))
			: buildFreeImageParams(ms, imageResolutionOptionsForKey(modelKey));
	const input = buildFreeInput(refs);
	const label = seg.name || (kind === "video" ? "视频占位" : "图片占位");
	const owner = currentOwner();

	attached.add(segId);
	armRunning(segId, undefined, owner); // 用户动作：占位转「生成中」（进撤销栈）
	void runOne({ segId, owner, purpose, modelKey, kind, label, params, input, prompt: resolvePresets(rawPrompt) });
	return { ok: true };
}

/** 一次生成的完整跑法（提交 / 找回共用同一套进度与终态处理） */
async function runOne(args: {
	segId: string;
	owner: string;
	purpose: Purpose;
	modelKey: string;
	kind: RtcGenKind;
	label: string;
	/** 提交用（找回时省略） */
	prompt?: string;
	params?: Record<string, unknown>;
	input?: Record<string, unknown>;
	/** 找回用（提交时省略） */
	resumeTask?: { taskId: string; adapterKey: string };
}): Promise<void> {
	const { segId, owner, kind, label } = args;
	try {
		const r = await runPurpose(args.purpose, {
			modelKey: args.modelKey,
			...(args.resumeTask ? { resumeTask: args.resumeTask } : { prompt: args.prompt, params: args.params, input: args.input }),
			// 提交确认即把「adapterKey|taskId」记进片段（进撤销栈——这是断连找回的唯一凭据，
			// 必须扛得住 Ctrl+Z 与关软件；片段随 rtcDoc 落项目文件）
			onTaskId: (taskId, adapterKey) => armRunning(segId, packTaskRef(adapterKey, taskId), owner),
			// 进度帧：静默写（不进撤销栈）+ 节流（见 rtcGenSink.mirrorProgress）
			// 第251轮：排队位次/阶段文案（TaskExtra）一并镜像进片段——时间轴块与工作台
			// 都经 lib/queueLabel.progressLabel 显示「排队中 · 第 3 位」而不是干巴巴的 0%。
			onProgress: (progress, status, _partialText, extra?: TaskExtra) => {
				if (status === "running" || status === "queued") mirrorProgress(segId, progress, owner, extra);
			},
		});
		if (!liveSegment(segId)) return; // 片段已被用户删掉 → 结果无处可落（服务端仍有台账，可到请求记录查看）
		if (r.status === "no_model") {
			markFailed(segId, "所选模型当前不可用（可能已被停用或未授权），请换一个模型后重试。", owner);
			return;
		}
		if (r.status === "failed") {
			markFailed(segId, r.error || "生成失败", owner);
			return;
		}
		if (!r.resultUri) {
			markFailed(segId, "生成完成但没有取到结果文件，请重试。", owner);
			return;
		}
		const media = kind; // video/image（audio 在提交前已拦下）
		const landed = await persistGenAsset({ resultUri: r.resultUri, assetId: r.assetId, rawLink: r.rawLink, kind: media, label, owner });
		const durationSec = await probeDurationSec(landed.uri, media);
		// 占位 → 结果（就地）：target 位置/时长分毫不动
		landMedia(segId, { media, uri: landed.uri, assetId: landed.assetId, durationSec, owner });
	} catch (err) {
		markFailed(segId, err instanceof Error ? err.message : "生成失败", owner);
	} finally {
		detach(segId);
	}
}

/**
 * 断连找回：扫当前 doc 里「status=running 且 taskRef 是 `adapterKey|taskId`」的自由占位，
 * 凭 taskRef 重挂集中轮询（**不重新提交、不再扣费**）。
 *
 * 由 [placeholderSwap.initRtcGenWatch](./placeholderSwap.ts) 在项目载入/文档变化时调用——
 * 这就是"重开客户端后进度自动续上"的来源：状态在片段上（已落盘），不在任何回调闭包里。
 * 已在跟踪的片段跳过（taskCenter 按 taskId 只留一个 handler，双挂会互相顶掉）。
 */
export function resumeFreeGens(): void {
	const doc = useRtcStore.getState().doc;
	if (!doc) return;
	const owner = currentOwner();
	for (const t of doc.tracks) {
		for (const seg of t.segments) {
			if (seg.kind !== "placeholder" || seg.status !== "running") continue;
			if (attached.has(seg.id)) continue;
			const ref = parseTaskRef(seg.taskRef);
			if (!ref || ref.kind !== "task") continue; // pending 台账那条链由 placeholderSwap 镜像负责
			const kind = segGenKind(seg);
			const purpose = genPurposeFor(kind);
			if (!purpose) continue;
			attached.add(seg.id);
			void runOne({
				segId: seg.id,
				owner,
				purpose,
				modelKey: "",
				kind,
				label: seg.name || "占位",
				resumeTask: { taskId: ref.taskId, adapterKey: ref.adapterKey },
			});
		}
	}
}

/** 自由占位「重试」：失败后按当前草稿重新提交（会再次扣费，与资产/分镜的「重试」同语义） */
export async function retryFreeGen(segId: string): Promise<FreeGenResult> {
	detach(segId);
	return startFreeGen(segId);
}
