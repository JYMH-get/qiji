/**
 * rtcGenCore —— 实时剪辑「结果占位 → 生成 → 进度回填 → 落成结果」闭环的**纯逻辑层**。
 *
 * 零 React、零 store、零 DOM——全是「输入片段/在途记录 → 输出补丁或判定」的纯函数，供
 * [rtcGenSink](./rtcGenSink.ts) / [freeGenActions](./freeGenActions.ts) / [placeholderSwap](./placeholderSwap.ts)
 * 调用，并由 [rtcGenCore.test.ts](./rtcGenCore.test.ts) 直接断言。
 *
 * ⚠ 核心语义（第237轮用户定稿，勿回退）——**轨道是结果的存放位置**：
 *   实时剪辑除了剪辑外，最大的优点是引入 AI 生成功能。轨道上的片段代表「结果」，
 *   **不能无缘无故删除东西，也不能无缘无故增加东西**：所有「准备生成 / 正在生成」的内容
 *   都以「结果占位」片段替代；**重新生成不覆盖原有结果**，而是在**上方轨道**新增一个结果占位
 *   （相当于画布模式的节点，但天然不堆叠——轨道就是最好的堆叠方式）。
 *   导出会导出时间轴上的所有；播放只看得见最上面的视频/图片（图层概念）。
 *
 * ⚠ 落笔规则（与 rtcStore 的两条写入通道对应）：
 *   - **占位 → media**：只改 kind/media/assetId/uri/source 窗口，`targetStartUs` 与
 *     `targetDurationUs` **分毫不动**（时长与素材不符也保留，裁剪交给用户——第235轮定稿），
 *     并清空整组占位态字段（status/progress/taskRef/error）；走 `commit`（进撤销栈）。
 *   - **进度帧 / 在途状态镜像**：走 `patchSilent`（不进撤销栈，见 rtcStore.patchSilent 注释）。
 */
import type { Capability, Purpose } from "@/contract";
import { clampDuration, clampImageResolution, resolveSize } from "@/lib/genParams";
import { clampDurationTo, clampToOptions, type VideoReqOptions } from "@/lib/videoMethods";
import type { RtcSegment } from "@/types/rtc";

/** 占位要生成的产物类型（= RtcSegment.genKind） */
export type RtcGenKind = NonNullable<RtcSegment["genKind"]>;

/* ────────────────────────── taskRef 编解码 ────────────────────────── */

/**
 * `RtcSegment.taskRef` 的两种取值（类型里只是一个字符串，语义在这里收口）：
 *   - **pending 台账 id**（形如 `gen-1730000000000-3`）：走 generationQueue 的生成
 *     （分镜出片 / 超分 / 去字幕）——在途状态由持久化的 `pendingGens` 驱动；
 *   - **`adapterKey|taskId`**：自由占位（无 shotRef）走 runPurpose 直连的生成——
 *     ⚠ 断连找回需要 taskId **与** adapterKey 两个值（purposeRunner.resumeTask 的入参），
 *     而 RtcSegment 本轮由时间轴任务独占不可扩字段，故用竖线编进同一个字符串。
 * 两者靠有没有竖线区分（adapterKey 与 pending id 都不含竖线）。
 */
export type ParsedTaskRef =
	| { kind: "task"; adapterKey: string; taskId: string }
	| { kind: "pending"; pendingId: string }
	| null;

/** 打包「adapterKey|taskId」；任一为空返回空串（调用方据此不写 taskRef） */
export function packTaskRef(adapterKey: string, taskId: string): string {
	const a = (adapterKey || "").trim();
	const t = (taskId || "").trim();
	return a && t ? `${a}|${t}` : "";
}

/** 解析 taskRef（空/非法 → null；无竖线 → pending 台账 id） */
export function parseTaskRef(ref?: string | null): ParsedTaskRef {
	const s = (ref || "").trim();
	if (!s) return null;
	const i = s.indexOf("|");
	if (i < 0) return { kind: "pending", pendingId: s };
	const adapterKey = s.slice(0, i).trim();
	const taskId = s.slice(i + 1).trim();
	if (!adapterKey || !taskId) return null; // 半截数据（如 "|abc"）：无从找回，当没有
	return { kind: "task", adapterKey, taskId };
}

/* ────────────────────────── 进度节流 ────────────────────────── */

/** 进度回填的最小步进（百分点）——低于这个变化不写盘 */
export const PROGRESS_MIN_STEP = 2;
/** 进度回填的最小间隔（毫秒）——小步变化也至少隔这么久才写一次 */
export const PROGRESS_MIN_GAP_MS = 500;

/** 进度值归一到 0–100 整数（非数字 → 0） */
export function clampProgress(v: unknown): number {
	const n = Math.round(Number(v));
	if (!Number.isFinite(n)) return 0;
	return Math.min(100, Math.max(0, n));
}

/**
 * 是否应把这一帧进度写进片段。
 * 规则：首帧（prev 未知）必写；变化 ≥ {@link PROGRESS_MIN_STEP} 必写；
 * 否则要同时满足「距上次写入 ≥ {@link PROGRESS_MIN_GAP_MS}」且「值确实变了」。
 * 目的：上游轮询 1.5–5s 一次、本地适配器更密，逐帧写会把去抖落盘与 React 渲染打满。
 */
export function shouldWriteProgress(
	prev: number | undefined,
	next: number,
	lastAtMs: number,
	nowMs: number,
): boolean {
	const n = clampProgress(next);
	if (prev === undefined) return true;
	const p = clampProgress(prev);
	if (Math.abs(n - p) >= PROGRESS_MIN_STEP) return true;
	return n !== p && nowMs - lastAtMs >= PROGRESS_MIN_GAP_MS;
}

/* ────────────────────────── 片段补丁（状态机迁移） ────────────────────────── */

/**
 * 补丁里显式写 `undefined` = **清除该字段**（patchSegmentDoc 用 `{...seg, ...patch}` 展开，
 * undefined 会盖掉旧值，落盘 JSON.stringify 时整键消失）。
 */
export type SegPatch = Partial<RtcSegment>;

/** 提交生成 → 占位转「生成中」（记 taskRef，清掉上一轮的失败原因） */
export function runningPatch(opts?: { taskRef?: string; progress?: number }): SegPatch {
	return {
		status: "running",
		error: undefined,
		...(opts?.taskRef ? { taskRef: opts.taskRef } : {}),
		...(opts?.progress !== undefined ? { progress: clampProgress(opts.progress) } : {}),
	};
}

/** 生成失败 → 占位转「失败」（**片段保留不删**，用户要能看到失败并重试；进度清掉） */
export function failedPatch(error: string): SegPatch {
	return { status: "failed", error: error || "生成失败", progress: undefined };
}

/**
 * 占位 → 结果（就地）：只改 kind/media/assetId/uri/source 窗口 + 清空整组占位态字段。
 * ⚠ **targetStartUs / targetDurationUs 不在补丁里**——时长与素材不符也保留，裁剪交给用户。
 */
export function mediaPatch(
	media: NonNullable<RtcSegment["media"]>,
	uri: string,
	assetId?: string,
	source?: { sourceStartUs: number; sourceDurationUs: number } | null,
): SegPatch {
	return {
		kind: "media",
		media,
		...(assetId ? { assetId } : {}),
		uri,
		...(source ? { sourceStartUs: source.sourceStartUs, sourceDurationUs: source.sourceDurationUs } : {}),
		status: undefined,
		progress: undefined,
		taskRef: undefined,
		error: undefined,
	};
}

/** 在途台账记录（PendingGen 的本层子集——纯逻辑层不引 projectFile 类型） */
export interface PendingLike {
	id: string;
	status: "running" | "failed";
	error?: string;
}

/**
 * 台账 → 占位状态镜像补丁（返回 null = 无需写入，调用方据此不落盘）。
 * ⚠ 这是「重开客户端后进度/状态还能续上」的关键：状态源不是提交时的回调闭包，而是
 *   **随项目落盘的 pendingGens**——重开后 resumePendingGenerations() 重挂轮询，
 *   台账一变本函数就把新状态镜像回占位片段。
 */
export function pendingMirrorPatch(seg: RtcSegment, pending: PendingLike): SegPatch | null {
	if (seg.kind !== "placeholder") return null; // 已落成结果 → 不再镜像（绝不把 media 打回占位）
	if (pending.status === "failed") {
		const err = pending.error || "生成失败";
		if (seg.status === "failed" && seg.error === err) return null;
		return failedPatch(err);
	}
	if (seg.status === "running") return null;
	return runningPatch();
}

/** 台账里已查无此单、本会话也没接管过它时的收尾文案（绝不让占位永远转圈） */
export const ORPHAN_TASK_ERROR = "生成任务已结束但结果没能自动落位（可到分镜历史查看结果，或直接重新生成）";

/** 孤儿占位（taskRef 指向的在途记录已消失）→ 转失败，附可操作说明 */
export function orphanPatch(): SegPatch {
	return failedPatch(ORPHAN_TASK_ERROR);
}

/* ────────────────────────── 自由占位（无 shotRef）的生成参数 ────────────────────────── */

/** 产物类型 → 模型能力（audio 无可用生成能力 → null，界面据此明确提示而不是给个点了没反应的按钮） */
export function genCapabilityFor(kind: RtcGenKind): Capability | null {
	if (kind === "video") return "video";
	if (kind === "image") return "image";
	return null;
}

/**
 * 产物类型 → Purpose。
 * image 用 `asset.scene.image`（库内通用文生图用途，分镜故事板同款——见 shotGenActions.genShotStoryboard）；
 * audio 无接线的生成用途（contract 里的 audio.tts 尚未接线）→ null。
 */
export function genPurposeFor(kind: RtcGenKind): Purpose | null {
	if (kind === "video") return "video.generate";
	if (kind === "image") return "asset.scene.image";
	return null;
}

/** 音频占位的说明文案（界面直说不支持，不留假按钮） */
export const AUDIO_GEN_UNSUPPORTED =
	"暂不支持音频生成，请从左侧素材面板拖入音频素材（或对视频片段右键「音频分离」）。";

/** 微秒 → 秒（至少 1 秒，用作视频时长默认值：占位多长就生成多长） */
export function segSeconds(us: number): number {
	const s = Math.round((Number(us) || 0) / 1_000_000);
	return Math.max(1, s);
}

/** 视频设置里与自由生成有关的字段（本层只读，不引 projectFile 类型） */
export interface FreeGenSettings {
	aspect?: string;
	resolution?: string;
	imageAspect?: string;
	imageResolution?: string;
	imageQuality?: string;
}

/**
 * 自由占位·视频参数（与 shotGenActions.genShotVideo 同尺：先按视频设置取值，再按当前模型
 * catalog 档位收敛——服务端控档一把尺）。
 * ⚠ 时长默认取**占位片段自身的时长**（占位多长就生成多长，最接近用户在时间轴上的意图），
 *   再经 clampDuration（4–15）与模型开放档 clampDurationTo 收敛。
 */
export function buildFreeVideoParams(
	targetDurationUs: number,
	ms: FreeGenSettings | undefined,
	req: VideoReqOptions,
): Record<string, unknown> {
	return {
		duration: clampDurationTo(clampDuration(segSeconds(targetDurationUs)), req.durations),
		resolution: clampToOptions(ms?.resolution ?? "720p", req.resolutions),
		aspect_ratio: clampToOptions(ms?.aspect ?? "16:9", req.aspects),
	};
}

/**
 * 自由占位·图片参数（与 assetGenActions.buildAssetBaseGenSpec / genShotStoryboard 同尺：
 * `{size, quality}`，分辨率档按当前生效图像模型的 catalog params 收敛）。
 */
export function buildFreeImageParams(
	ms: FreeGenSettings | undefined,
	resOptions?: { v: string }[],
): Record<string, unknown> {
	const aspect = ms?.imageAspect || "16:9";
	const resolution = clampImageResolution(ms?.imageResolution ?? "2k", resOptions);
	return { size: resolveSize(aspect, resolution), quality: ms?.imageQuality || "high" };
}

/** 已公网化的垫素材引用（提交前由 ensurePublicUrl 解析得到） */
export interface FreeRefUrl {
	url: string;
	name?: string;
	media: "image" | "video" | "audio";
}

/**
 * 垫素材按模态分组成 `input`（保序对齐上游 @ImageN/@VideoN/@AudioN 图例编号）。
 * ⚠ 一条都不许静默丢——取不到公网直链的素材必须在调用方**明确报错且不发请求**
 *   （丢一条即整段编号错位）。空数组返回 undefined（不带 input 字段）。
 */
export function buildFreeInput(refs: FreeRefUrl[]): Record<string, unknown> | undefined {
	const images = refs.filter((r) => r.media === "image").map((r) => ({ url: r.url, name: r.name }));
	const videos = refs.filter((r) => r.media === "video").map((r) => ({ url: r.url, name: r.name }));
	const audios = refs.filter((r) => r.media === "audio").map((r) => ({ url: r.url, name: r.name }));
	const input: Record<string, unknown> = {};
	if (images.length) input.images = images;
	if (videos.length) input.videos = videos;
	if (audios.length) input.audios = audios;
	return Object.keys(input).length ? input : undefined;
}

/**
 * 补丁是否**什么都不改**（逐键比对现值）——true 时调用方应返回原 doc 引用，
 * 让 commit/patchSilent 当 no-op（不进撤销栈、不触发落盘与重渲染）。
 * 高频回填链路上这层比对很关键：轮询每秒来一帧，值没变就不该惊动整条落盘链。
 */
export function segPatchIsNoop(seg: RtcSegment, patch: SegPatch): boolean {
	const cur = seg as unknown as Record<string, unknown>;
	for (const [k, v] of Object.entries(patch)) {
		if (cur[k] !== v) return false;
	}
	return true;
}

/* ────────────────────────── 结果 → source 窗口 ────────────────────────── */

/**
 * 产物真实时长（秒）→ 片段 source 窗口。
 * 图片不建窗口（图片可任意拉伸，与拖放入轨/replaceSegmentMedia 的图片语义一致）；
 * 视频/音频探不到时长（探测失败）也不建窗口（宁可没有，也不写一个假的把 trim 卡死）。
 */
export function sourceWindowFor(
	media: NonNullable<RtcSegment["media"]>,
	durationSec: number,
): { sourceStartUs: number; sourceDurationUs: number } | null {
	if (media === "image") return null;
	const us = Math.round((Number(durationSec) || 0) * 1_000_000);
	return us > 0 ? { sourceStartUs: 0, sourceDurationUs: us } : null;
}
