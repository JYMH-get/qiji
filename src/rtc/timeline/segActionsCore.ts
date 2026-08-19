/**
 * segActionsCore —— 时间轴片段动作（超分 / 去字幕 / 音频分离 / 重新生成 / 添加占位）的**纯逻辑层**。
 *
 * 零 React、零 DOM、零 store —— 全部是「输入 doc/片段 → 输出落位决策或新片段」的纯函数，供
 * [segActions.tsx](./segActions.tsx) 调用、供单测直接断言（vitest 跑在 node 环境，纯函数不碰浏览器 API）。
 *
 * ⚠ 锁定规则（第237轮用户定稿，勿回退）——**轨道即结果堆叠**：
 *   轨道上的片段代表「结果」。**任何生成动作都不得就地覆盖或删除已有结果**；生成中的产物一律以
 *   「结果占位」片段呈现；**重新生成 = 在上方轨道新增一个结果占位**，生成完成后该占位**就地**变成
 *   新结果（只改 kind/media/assetId/uri/source 窗口，targetStartUs/targetDurationUs 分毫不动），
 *   原结果原位保留在下方轨道。轨道的上下层就是版本堆叠（等价画布模式节点的 resultHistory 堆叠，
 *   但用轨道层表达，不再另做抽屉）。
 *
 * ⚠ 上方轨道的选择算法（pickResultTrack）：**优先复用「源片段正上方那条同类型轨道」**（该时间段空闲
 *   且未锁才用）→ 逐条继续往上找空闲的 → 都没有才在源轨道**正上方新建一条**。
 *   （别无脑每次新建：版本一多轨道会爆炸。）
 *   「上方」= 同类型轨道里 doc.tracks 数组下标更小者——渲染侧 sortTracksByType 只按类型排、同类型
 *   保持数组相对序（稳定排序），所以同类型内「数组更靠前 = 显示更靠上」，这里无需再引排序函数。
 */
import type { RtcDoc, RtcSegment, RtcTrack, RtcTrackType } from "@/types/rtc";

/**
 * 生成动作类型（决定占位片段的名字前缀）。
 * ⚠ 与 `RtcSegment.genKind` 严格区分（跨 agent 收口结论，勿混）：
 *   - **`genKind` 只填「产物类型」**（video/image/audio）——时间轴渲染与「添加占位」都按它读；
 *   - **动作语义写进 `name`**（`超分 · 昭阳长公主` / `去字幕 · 1集分镜2` / `重新生成 · …`），
 *     片段上本就显示 name，用户一眼看出是哪种再生成；
 *   - 血缘用 `originSegId` 指向源片段（渲染侧据此打「新版本」角标）。
 */
export type ResultAction = "shot" | "upscale" | "desub";

/* ────────────────────────── 菜单项适用性判定 ────────────────────────── */

export type SegActionKey = "upscale" | "desub" | "separateAudio" | "regenerate";
/** ok=可执行；否则带**给用户看的**原因（菜单项照常显示、点击时明确报错，绝不静默失败） */
export type Availability = { ok: true } | { ok: false; reason: string };
/** 键不存在 = 该动作对这类片段**根本不适用**（菜单不显示该项） */
export type SegAvailability = Partial<Record<SegActionKey, Availability>>;

export interface SegActionEnv {
	/** 是否桌面版（音频分离依赖随包内置 ffmpeg） */
	tauri: boolean;
}

const NO_SHOT_REF =
	"该片段不是由分镜生成的成片（没有关联分镜），暂不支持超分/去字幕——请在资产模式对该视频处理后再拖入时间轴。";
const NO_SRC = "该片段没有可处理的源文件（素材未落地或已失效）。";

/**
 * 判定右键片段可用哪些动作。
 *  - 视频片段（视频轨 media/video）：超分 / 去字幕 / 音频分离；有 shotRef 时另有「重新生成」；
 *  - 图片片段（视频轨 media/image）：仅超分（走图像超分；去字幕的 video-erase 能力对图片不适用）；
 *  - 占位符：有 shotRef 才有「重新生成」（裸占位=异常数据，不给动作）；
 *  - 音频/文本轨片段：无 AI 动作。
 * ⚠ 超分/去字幕**不修改源片段**（结果落在上方轨道的新占位），故源轨道被锁不影响；
 *   音频分离要把源片段设为静音，所以锁轨要拦。
 */
export function segActionAvailability(seg: RtcSegment, track: RtcTrack, env: SegActionEnv): SegAvailability {
	if (seg.kind === "placeholder") {
		// 占位符本身就是这一版的坑位：重新生成=原地重跑（不新增片段）
		return seg.shotRef ? { regenerate: { ok: true } } : {};
	}
	if (seg.kind !== "media" || track.type !== "video") return {};
	const media = seg.media ?? "video";
	if (media !== "video" && media !== "image") return {};
	// 超分/去字幕的落地锚点=分镜的派生记录表（库内唯一的媒体处理结果落点），故必须有 shotRef
	const anchored: Availability = !seg.shotRef
		? { ok: false, reason: NO_SHOT_REF }
		: !seg.uri
			? { ok: false, reason: NO_SRC }
			: { ok: true };
	// 图片片段：只有超分（图像超分），去字幕的 video-erase 能力对图片不适用
	if (media === "image") return { upscale: anchored };
	// 视频片段：超分 / 去字幕 / 音频分离（+ 有 shotRef 时的重新生成）
	const out: SegAvailability = { upscale: anchored, desub: anchored };
	out.separateAudio = !env.tauri
		? { ok: false, reason: "音频分离需要桌面版客户端（浏览器预览环境没有内置 ffmpeg）。" }
		: !seg.uri
			? { ok: false, reason: "该片段没有可分离的源视频文件（素材未落地或已失效）。" }
			: track.locked
				? { ok: false, reason: "轨道已锁定：分离音频会把源片段设为静音，请先解锁该轨道。" }
				: { ok: true };
	// 已有成片的分镜片段：重新生成 = 上方轨道新增结果占位（原结果保留）
	if (seg.shotRef) out.regenerate = { ok: true };
	return out;
}

/* ────────────────────────── 轨道落位 ────────────────────────── */

/** 落位决策：复用既有轨道 / 在 insertAtIndex 处新建一条（插进 doc.tracks 数组的该下标） */
export type TrackPick = { kind: "existing"; trackId: string } | { kind: "create"; insertAtIndex: number };

/** [startUs, startUs+durUs) 在该轨道上是否完全空闲（与任一片段相交即不空闲） */
export function isWindowFree(track: RtcTrack, startUs: number, durUs: number): boolean {
	const end = startUs + durUs;
	return !track.segments.some((s) => s.targetStartUs < end && startUs < s.targetStartUs + s.targetDurationUs);
}

/**
 * 结果占位落哪条轨道：源片段所在轨道**正上方**起逐条往上找「同类型 + 未锁 + 该时间窗空闲」的轨道；
 * 找不到就在源轨道正上方新建一条（insertAtIndex = 源轨道在 doc.tracks 里的下标）。
 * 源轨道不存在（数据异常）→ 在最前面新建。
 */
export function pickResultTrack(doc: RtcDoc, sourceTrackId: string, startUs: number, durUs: number): TrackPick {
	const srcIdx = doc.tracks.findIndex((t) => t.id === sourceTrackId);
	if (srcIdx < 0) return { kind: "create", insertAtIndex: 0 };
	const type = doc.tracks[srcIdx].type;
	for (let i = srcIdx - 1; i >= 0; i--) {
		const t = doc.tracks[i];
		if (t.type !== type || t.locked) continue;
		if (isWindowFree(t, startUs, durUs)) return { kind: "existing", trackId: t.id };
	}
	return { kind: "create", insertAtIndex: srcIdx };
}

/**
 * 音频分离产物落哪条音频轨：首条「未锁 + 该时间窗空闲」的音频轨（保证与源视频**严格对齐**，
 * 绝不被 addSegment 的夹隙语义挪位）；没有就新建一条（追加到末尾——音频轨本就排在最下）。
 */
export function pickAudioTrack(doc: RtcDoc, startUs: number, durUs: number): TrackPick {
	for (const t of doc.tracks) {
		if (t.type !== "audio" || t.locked) continue;
		if (isWindowFree(t, startUs, durUs)) return { kind: "existing", trackId: t.id };
	}
	return { kind: "create", insertAtIndex: doc.tracks.length };
}

/* ────────────────────────── 片段构造 ────────────────────────── */

/** 动作 → 名字前缀（动作语义的唯一表达处，见 ResultAction 注释） */
const ACTION_LABEL: Record<ResultAction, string> = { shot: "重新生成", upscale: "超分", desub: "去字幕" };

/**
 * 由源片段生成「结果占位」：**同 target 窗口**（位置/时长与源一致，落在上方轨道形成版本层），
 * 带血缘 originSegId；`genKind`=产物类型（沿用源片段的 media）；`name`=「动作 · 源名」。
 * shotRef 只在「重新生成分镜」时继承——超分/去字幕的占位不是分镜坑位，继承了会让右栏错当分镜工作台。
 */
export function buildResultPlaceholder(
	src: RtcSegment,
	opts: { id: string; action: ResultAction; taskRef?: string; status?: RtcSegment["status"] },
): RtcSegment {
	const media = src.media ?? "video";
	return {
		id: opts.id,
		kind: "placeholder",
		media,
		name: `${ACTION_LABEL[opts.action]} · ${src.name || "片段"}`,
		targetStartUs: src.targetStartUs,
		targetDurationUs: src.targetDurationUs,
		originSegId: src.id,
		genKind: media,
		...(opts.status ? { status: opts.status } : {}),
		...(opts.taskRef ? { taskRef: opts.taskRef } : {}),
		...(opts.action === "shot" && src.shotRef ? { shotRef: src.shotRef } : {}),
	};
}

/** 空白区右键「添加占位」的默认时长（微秒）：视频/音频 5s、图片 3s。
 *  ⚠ 图片档只是**回退值**——调用方（segActions）应传入 durUs=设置里的「图片默认时长」
 *  （rtcEditorSettingsStore.imageDefaultSec，默认同为 3s；本纯逻辑层不读 store）。 */
export const BLANK_PLACEHOLDER_US: Record<"video" | "image" | "audio", number> = {
	video: 5_000_000,
	image: 3_000_000,
	audio: 5_000_000,
};

/** 轨道类型 → 可添加的占位类型（视频轨可放视频/图片；音频轨放音频；文本轨无） */
export function blankPlaceholderKinds(type: RtcTrackType): ("video" | "image" | "audio")[] {
	if (type === "video") return ["video", "image"];
	if (type === "audio") return ["audio"];
	return [];
}

/** 空白区新建的「准备生成」占位（无 assetId/uri；status=pending，genKind=要生成的产物类型）。
 *  durUs 可选覆盖时长（图片档由调用方传设置里的「图片默认时长」；非法/缺省回退档位表）。 */
export function buildBlankPlaceholder(
	media: "video" | "image" | "audio",
	atUs: number,
	id: string,
	durUs?: number,
): RtcSegment {
	const label = media === "video" ? "视频" : media === "image" ? "图片" : "音频";
	const dur = durUs != null && Number.isFinite(durUs) && durUs > 0 ? Math.round(durUs) : BLANK_PLACEHOLDER_US[media];
	return {
		id,
		kind: "placeholder",
		media,
		genKind: media,
		name: `${label}占位`,
		targetStartUs: Math.max(0, Math.round(atUs)),
		targetDurationUs: dur,
		status: "pending",
	};
}

/**
 * 音频分离产物片段：与源视频片段**同 target 窗口**；source 窗口原样继承
 * （抽出的音轨与源视频共用同一条时间线，窗口一致才对得上画面；源无窗口则同样不建）；
 * speed/volume 继承（源片段随后被设为静音，音量语义转移到音频片段）。
 */
export function audioSegmentFor(
	src: RtcSegment,
	opts: { id: string; assetId?: string; uri?: string },
): RtcSegment {
	const hasSource = src.sourceStartUs != null && src.sourceDurationUs != null;
	return {
		id: opts.id,
		kind: "media",
		media: "audio",
		name: `${src.name || "视频"}·音频`,
		...(opts.assetId ? { assetId: opts.assetId } : {}),
		...(opts.uri ? { uri: opts.uri } : {}),
		targetStartUs: src.targetStartUs,
		targetDurationUs: src.targetDurationUs,
		...(hasSource ? { sourceStartUs: src.sourceStartUs, sourceDurationUs: src.sourceDurationUs } : {}),
		...(src.speed != null && src.speed !== 1 ? { speed: src.speed } : {}),
		...(src.volume != null ? { volume: src.volume } : {}),
	};
}

/* ────────────────────────── 派生记录标号 ────────────────────────── */

/** 分镜上的派生记录（VideoDerivedRecord 子集——本层只关心标号解析，不引 projectFile 类型） */
interface DerivedLike {
	uri: string;
	label: string;
}

/**
 * 视频派生记录标号：恒为 `v{n}+`（超分）/ `v{n}-`（去字幕），n=链条根记录号。
 * 与 [Frame161195.doProcessVideo](@/views/Frame161195) 同尺——差别只在表格模式那边还会用
 * `shot.videoActiveKey`（占位期同 uri 分不清选中哪条）消歧，时间轴片段直接持有确定的 uri，无需该步。
 */
export function derivedVideoLabel(
	shot: { videoUris?: string[]; videoDerived?: DerivedLike[] },
	srcUri: string,
	mode: "upscale" | "desub",
): { label: string; srcLabel: string } {
	const uris = shot.videoUris || [];
	const rootOf = (label: string) => parseInt(label.match(/^v(\d+)/)?.[1] || "1", 10);
	const baseIdx = uris.indexOf(srcUri);
	let rootN: number;
	let srcLabel: string;
	if (baseIdx >= 0) {
		rootN = baseIdx + 1;
		srcLabel = `v${baseIdx + 1}`;
	} else {
		const rec = (shot.videoDerived || []).find((d) => d.uri === srcUri);
		if (rec) {
			rootN = rootOf(rec.label);
			srcLabel = rec.label;
		} else {
			rootN = 1;
			srcLabel = "v1";
		}
	}
	return { label: `v${rootN}${mode === "upscale" ? "+" : "-"}`, srcLabel };
}
