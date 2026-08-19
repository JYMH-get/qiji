/**
 * rtcOps.ts — 实时剪辑文档的纯函数操作（不可变更新，全部可单测）
 *
 * 不变量（所有操作共同维持）：
 *   - 轨道内 segments 恒按 targetStartUs 升序、互不重叠；
 *   - 无效输入（找不到片段/轨道、边界 no-op）返回**原 doc 引用**（零开销跳过重渲染/落盘）；
 *   - 重叠处理策略（定稿）：**夹到最近空隙**——期望位置被占时，把片段钳到所有能容纳它的
 *     空隙中「离期望位置最近的合法起点」（并列取更早的空隙），绝不推挤其它片段、绝不拒绝。
 *   - ⚠ 素材唯一性：split 等一切操作只切时间窗口、**绝不产生新素材实体**（assetId 原样共享）。
 *
 * ⚠ 主轨不变量（剪映式轨道分层，勿回退）：
 *   - **主轨 = `doc.tracks` 数组里第一条 `type==="video"` 的轨道**（与 rtcPlayback.mainVideoTrack
 *     同定义，别处不得另立门户）；
 *   - 新建 video 轨恒插在主轨**之后**（addTrack / insertTrackAt 都守这条），绝不抢占主轨身份；
 *   - 主轨**不可删**（removeTrack 对主轨 no-op）；
 *   - `doc.tracks` 的数组顺序是数据层真相（主轨解析、jianyingDraft 导出 render_index 都依赖它），
 *     时间轴上下分层只是**显示序**（orderTracksForDisplay），**绝不为了显示去重排 doc.tracks**。
 */
import { genId } from "./id";
import type { RtcDoc, RtcSegment, RtcTrack, RtcTrackType } from "@/types/rtc";
import { createRtcTrack } from "@/types/rtc";
import { splitKeyframes } from "./rtcKeyframes"; // ── 第二批：定格分割时的关键帧分账

/** 片段最小时长（微秒）：裁剪钳位下限，防出现零长/负长片段 */
export const MIN_SEGMENT_US = 1000;

const US_PER_SEC = 1_000_000;

function segEnd(s: RtcSegment): number {
	return s.targetStartUs + s.targetDurationUs;
}

function sortSegs(segs: RtcSegment[]): RtcSegment[] {
	return [...segs].sort((a, b) => a.targetStartUs - b.targetStartUs);
}

function findSeg(doc: RtcDoc, segId: string): { track: RtcTrack; seg: RtcSegment; segIndex: number } | null {
	for (const track of doc.tracks) {
		const segIndex = track.segments.findIndex((s) => s.id === segId);
		if (segIndex >= 0) return { track, seg: track.segments[segIndex], segIndex };
	}
	return null;
}

/** 替换某条轨道（返回新 doc） */
function replaceTrack(doc: RtcDoc, trackId: string, next: RtcTrack): RtcDoc {
	return { ...doc, tracks: doc.tracks.map((t) => (t.id === trackId ? next : t)) };
}

/** 该片段是否带源素材裁剪窗口（media/compound 且 source 双字段齐备；placeholder 无源约束）。
 *  ⚠ 第四批：compound 的 source 窗口 = 子时间轴时间窗（与素材引用同构）——trim 联动收缩窗口、
 *  split 切成互补窗口且**共享同一 subDocId**（绝不复制 subDoc），全靠这里把 compound 认进来。 */
function hasSourceWindow(seg: RtcSegment): boolean {
	return (
		(seg.kind === "media" || seg.kind === "compound") &&
		seg.sourceStartUs != null &&
		seg.sourceDurationUs != null
	);
}

/**
 * 夹到最近空隙：在 others（不含待放片段）中为时长 durUs 的片段找离 desiredUs 最近的合法起点。
 * 期望位置本身空闲则原样返回；负值先钳到 0；尾部空隙无限长，恒有解。
 */
function clampToNearestGap(others: RtcSegment[], durUs: number, desiredUs: number): number {
	const sorted = sortSegs(others);
	const desired = Math.max(0, desiredUs);
	// 收集所有能容纳 durUs 的空隙，表示为合法起点区间 [lo, hi]
	const gaps: Array<{ lo: number; hi: number }> = [];
	let cursor = 0;
	for (const s of sorted) {
		if (s.targetStartUs - cursor >= durUs) gaps.push({ lo: cursor, hi: s.targetStartUs - durUs });
		cursor = Math.max(cursor, segEnd(s));
	}
	gaps.push({ lo: cursor, hi: Infinity }); // 尾部空隙
	let best = gaps[gaps.length - 1].lo;
	let bestCost = Infinity;
	for (const g of gaps) {
		const candidate = Math.min(Math.max(desired, g.lo), g.hi);
		const cost = Math.abs(candidate - desired);
		if (cost < bestCost) { // 严格小于：并列取更早的空隙
			bestCost = cost;
			best = candidate;
		}
	}
	return best;
}

/* ────────────────────────── 轨道分层（主轨 / 显示序 / 缝隙） ────────────────────────── */

/** 轨道类型分层优先级（值小=显示更靠上的组）：文本 → 视频 → 音频 */
export const TRACK_TYPE_ORDER: Record<RtcTrackType, number> = { text: 0, video: 1, audio: 2 };

/**
 * 主轨 id = 数组里第一条 video 轨（无视频轨返回 null）。
 * ⚠ 与 rtcPlayback.mainVideoTrack 同定义——主轨语义只有这一处口径，勿另算。
 */
export function mainVideoTrackId(tracks: RtcTrack[]): string | null {
	return tracks.find((t) => t.type === "video")?.id ?? null;
}

/**
 * 时间轴**显示序**（剪映式分层，从上到下）：
 *   文本轨组 → 非主视频轨（**越晚建的越靠上**）→ 主轨 → 音频轨组。
 *
 * ⚠ 只影响 UI 渲染顺序；`doc.tracks` 数组顺序是数据层真相，绝不为了显示去重排它。
 * 非主视频轨取数组倒序：新建 video 轨恒追加在视频组数组末端（见 addTrack/insertTrackAt），
 * 倒过来看就是「新轨在上、主轨压底」。文本/音频组显示序 = 数组序。
 */
export function orderTracksForDisplay(tracks: RtcTrack[]): RtcTrack[] {
	const text = tracks.filter((t) => t.type === "text");
	const video = tracks.filter((t) => t.type === "video");
	const audio = tracks.filter((t) => t.type === "audio");
	const [main, ...rest] = video;
	return [...text, ...rest.reverse(), ...(main ? [main] : []), ...audio];
}

/**
 * 某类型轨道组在 `doc.tracks` 数组里的「组末端」插入位：
 * 组内有轨 → 最后一条之后；组为空 → 第一条更靠后类型之前（维持数组按类型分组有序）。
 */
function groupEndIndex(tracks: RtcTrack[], type: RtcTrackType): number {
	let last = -1;
	for (let i = 0; i < tracks.length; i++) if (tracks[i].type === type) last = i;
	if (last >= 0) return last + 1;
	const after = tracks.findIndex((t) => TRACK_TYPE_ORDER[t.type] > TRACK_TYPE_ORDER[type]);
	return after === -1 ? tracks.length : after;
}

/**
 * 显示序上第 gap 条缝隙（gap=0 最顶、gap=行数 最底）能否容纳一条新的 type 轨道。
 * 判据：缝隙上/下两行的类型分层不能被新轨道破坏 + **主轨下方的缝隙对 video 非法**
 * （主轨恒在视频组最下，新 video 轨永远显示在它上面——见 orderTracksForDisplay）。
 */
export function gapLegalForType(tracks: RtcTrack[], gap: number, type: RtcTrackType): boolean {
	const rows = orderTracksForDisplay(tracks);
	if (!Number.isInteger(gap) || gap < 0 || gap > rows.length) return false;
	const above = rows[gap - 1];
	const below = rows[gap];
	if (above && TRACK_TYPE_ORDER[above.type] > TRACK_TYPE_ORDER[type]) return false;
	if (below && TRACK_TYPE_ORDER[below.type] < TRACK_TYPE_ORDER[type]) return false;
	if (type === "video" && above && above.id === mainVideoTrackId(tracks)) return false;
	return true;
}

/**
 * 从 rawGap 出发找最近的合法缝隙（同距优先取更靠下的）；一条都没有返回 null。
 * 用于「指针落在轨道区之外（标尺上方 / 底部空白）」时把落点收敛到该类型能去的地方
 * ——例如视频片段拖到最底部空白，收敛为「主轨上方」（新 video 轨绝不越到主轨之下）。
 */
export function nearestLegalGap(tracks: RtcTrack[], rawGap: number, type: RtcTrackType): number | null {
	const max = orderTracksForDisplay(tracks).length;
	const start = Math.min(Math.max(0, Math.round(rawGap)), max);
	for (let d = 0; d <= max; d++) {
		const down = start + d;
		if (down <= max && gapLegalForType(tracks, down, type)) return down;
		const up = start - d;
		if (up >= 0 && gapLegalForType(tracks, up, type)) return up;
	}
	return null;
}

/**
 * 显示序缝隙 → `doc.tracks` 的插入 index（调用方须先用 gapLegalForType 判过合法）。
 *
 * ⚠ 视频组是「数组序倒过来显示」，所以新轨要显示在 above 之下 = 数组里插在 above **之前**；
 * 缝隙在视频组最上方（above 不是视频轨）时落到视频组数组末端 = 显示最顶，天然满足主轨不变量。
 * 文本/音频组显示序 = 数组序，插在 below 之前即可。
 */
export function gapInsertIndex(tracks: RtcTrack[], gap: number, type: RtcTrackType): number {
	const rows = orderTracksForDisplay(tracks);
	const above = rows[gap - 1];
	const below = rows[gap];
	if (type === "video") {
		if (above && above.type === "video") return tracks.indexOf(above);
		return groupEndIndex(tracks, "video");
	}
	if (below && below.type === type) return tracks.indexOf(below);
	return groupEndIndex(tracks, type);
}

/* ────────────────────────── 轨道操作 ────────────────────────── */

/**
 * 追加轨道（按类型优先级插入到同类型组末尾：text < video < audio）。
 * ⚠ 新 video 轨落在视频组末端 = 恒在主轨之后，主轨身份不变（显示上出现在视频组最顶）。
 */
export function addTrack(doc: RtcDoc, type: RtcTrackType, name?: string): RtcDoc {
	const newTrack = createRtcTrack(type, name);
	const next = [...doc.tracks] as RtcTrack[];
	next.splice(groupEndIndex(doc.tracks, type), 0, newTrack);
	return { ...doc, tracks: next };
}

/**
 * 在 `doc.tracks` 的指定 index 处插入一条新轨道（index 越界自动钳到 [0, 长度]）。
 * opts.id 可预先指定（调用方 genId 后即可直接引用新轨，无需事后从数组里猜）。
 *
 * ⚠ 主轨不变量：type="video" 且落点在主轨之前/之上时**一律钳到主轨之后**——
 * 新视频轨绝不允许抢占「第一条 video 轨」的主轨身份。
 */
export function insertTrackAt(
	doc: RtcDoc,
	type: RtcTrackType,
	index: number,
	opts?: { id?: string; name?: string },
): RtcDoc {
	const created = createRtcTrack(type, opts?.name);
	const track: RtcTrack = opts?.id ? { ...created, id: opts.id } : created;
	const raw = Number.isFinite(index) ? Math.round(index) : doc.tracks.length;
	let at = Math.min(Math.max(0, raw), doc.tracks.length);
	if (type === "video") {
		const mainIdx = doc.tracks.findIndex((t) => t.type === "video");
		if (mainIdx >= 0 && at <= mainIdx) at = mainIdx + 1;
	}
	const tracks = [...doc.tracks];
	tracks.splice(at, 0, track);
	return { ...doc, tracks };
}

/** 按 trackIds 重排轨道（未在 doc 中的 id 忽略；返回原 doc）；同类型保持传入的相对序 */
export function reorderTracks(doc: RtcDoc, trackIds: string[]): RtcDoc {
	const existing = new Set(doc.tracks.map((t) => t.id));
	const ordered = trackIds
		.filter((id) => existing.has(id))
		.map((id) => doc.tracks.find((t) => t.id === id)!);
	const remaining = doc.tracks.filter((t) => !trackIds.includes(t.id));
	const result = [...ordered, ...remaining];
	if (result.length !== doc.tracks.length) return doc;
	for (let i = 0; i < result.length; i++) {
		if (result[i].id !== doc.tracks[i].id) return { ...doc, tracks: result };
	}
	return doc; // 顺序未变
}

/**
 * 删除轨道（含其上全部片段）；未找到返回原 doc。
 * ⚠ **主轨不可删**（第一条 video 轨是画面基准，见文件头不变量）——删主轨 no-op 返回原引用。
 */
export function removeTrack(doc: RtcDoc, trackId: string): RtcDoc {
	if (!doc.tracks.some((t) => t.id === trackId)) return doc;
	if (trackId === mainVideoTrackId(doc.tracks)) return doc;
	return { ...doc, tracks: doc.tracks.filter((t) => t.id !== trackId) };
}

/** 修改轨道属性（name/muted/locked）；未找到返回原 doc */
export function setTrackProps(
	doc: RtcDoc,
	trackId: string,
	props: Partial<Pick<RtcTrack, "name" | "muted" | "locked">>,
): RtcDoc {
	const track = doc.tracks.find((t) => t.id === trackId);
	if (!track) return doc;
	return replaceTrack(doc, trackId, { ...track, ...props });
}

/* ────────────────────────── 片段操作 ────────────────────────── */

/**
 * 添加片段到指定轨道：落在 segment.targetStartUs 期望位置，被占则夹到最近空隙；维持排序。
 * 时长最低钳到 MIN_SEGMENT_US；轨道未找到返回原 doc。
 */
export function addSegment(doc: RtcDoc, trackId: string, segment: RtcSegment): RtcDoc {
	const track = doc.tracks.find((t) => t.id === trackId);
	if (!track) return doc;
	const dur = Math.max(MIN_SEGMENT_US, segment.targetDurationUs);
	const start = clampToNearestGap(track.segments, dur, segment.targetStartUs);
	const placed: RtcSegment = { ...segment, targetStartUs: start, targetDurationUs: dur };
	return replaceTrack(doc, trackId, { ...track, segments: sortSegs([...track.segments, placed]) });
}

/**
 * 移动片段（可跨轨）：目标位置被占则夹到最近空隙；维持排序。
 * 片段或目标轨道未找到返回原 doc。
 */
export function moveSegment(doc: RtcDoc, segId: string, trackId: string, targetStartUs: number): RtcDoc {
	const found = findSeg(doc, segId);
	const target = doc.tracks.find((t) => t.id === trackId);
	if (!found || !target) return doc;
	const { track: source, seg } = found;
	// 目标轨道上除自身以外的片段（同轨移动时把自己排除掉再找空隙）
	const others = target.segments.filter((s) => s.id !== segId);
	const start = clampToNearestGap(others, seg.targetDurationUs, targetStartUs);
	const moved: RtcSegment = { ...seg, targetStartUs: start };
	return {
		...doc,
		tracks: doc.tracks.map((t) => {
			if (t.id === source.id && t.id === target.id) return { ...t, segments: sortSegs([...others, moved]) };
			if (t.id === source.id) return { ...t, segments: t.segments.filter((s) => s.id !== segId) };
			if (t.id === target.id) return { ...t, segments: sortSegs([...t.segments, moved]) };
			return t;
		}),
	};
}

/**
 * 第238轮补充10：原文改「派生只读」——历史 doc 里落过盘的 role:"script" 原文轨（补充8-9 的
 * 旧形态）加载时整轨清除（原文现由 rtcScriptLane 从主轨实时派生，不再是片段数据）。
 * 无该轨返回原引用零开销。
 */
export function pruneScriptTracks(doc: RtcDoc): RtcDoc {
	return doc.tracks.some((t) => t.role === "script")
		? { ...doc, tracks: doc.tracks.filter((t) => t.role !== "script") }
		: doc;
}

/**
 * 裁剪片段边缘：edge="start" 动左缘（正 delta=向右收），edge="end" 动右缘（正 delta=向右伸）。
 * 联动 source 窗口（按 speed 换算）与 target 时长；钳位约束：
 *   - 时长下限 MIN_SEGMENT_US；
 *   - 左缘不越前一片段右缘 / 时间轴 0；右缘不越后一片段左缘；
 *   - 带源窗口的片段：左缘外扩受 sourceStartUs≥0 约束、右缘外扩受 opts.sourceTotalUs（源素材总长，
 *     调用方可选提供）约束；placeholder 无源约束。
 * 钳位后 delta 为 0 或片段未找到 → 返回原 doc。
 */
export function trimSegment(
	doc: RtcDoc,
	segId: string,
	edge: "start" | "end",
	deltaUs: number,
	opts?: { sourceTotalUs?: number },
): RtcDoc {
	const found = findSeg(doc, segId);
	if (!found) return doc;
	const { track, seg, segIndex } = found;
	const speed = seg.speed ?? 1;
	const withSource = hasSourceWindow(seg);
	const prev = track.segments[segIndex - 1];
	const next = track.segments[segIndex + 1];

	let d = deltaUs;
	let patched: RtcSegment;
	if (edge === "start") {
		// 收缩上限：至少留 MIN_SEGMENT_US
		d = Math.min(d, seg.targetDurationUs - MIN_SEGMENT_US);
		// 外扩下限：不越前片段右缘 / 时间轴 0
		const floorUs = prev ? segEnd(prev) : 0;
		d = Math.max(d, floorUs - seg.targetStartUs);
		// 源约束：源窗口起点不越 0
		if (withSource) d = Math.max(d, -(seg.sourceStartUs as number) / speed);
		if (d === 0) return doc;
		patched = {
			...seg,
			targetStartUs: seg.targetStartUs + d,
			targetDurationUs: seg.targetDurationUs - d,
			...(withSource
				? {
					sourceStartUs: Math.round((seg.sourceStartUs as number) + d * speed),
					sourceDurationUs: Math.round((seg.sourceDurationUs as number) - d * speed),
				}
				: {}),
		};
	} else {
		// 收缩下限：至少留 MIN_SEGMENT_US
		d = Math.max(d, MIN_SEGMENT_US - seg.targetDurationUs);
		// 外扩上限：不越后片段左缘
		if (next) d = Math.min(d, next.targetStartUs - segEnd(seg));
		// 源约束：源窗口终点不越素材总长（调用方提供时）
		if (withSource && opts?.sourceTotalUs != null) {
			const headroom = opts.sourceTotalUs - (seg.sourceStartUs as number) - (seg.sourceDurationUs as number);
			d = Math.min(d, headroom / speed);
		}
		if (d === 0) return doc;
		patched = {
			...seg,
			targetDurationUs: seg.targetDurationUs + d,
			...(withSource
				? { sourceDurationUs: Math.round((seg.sourceDurationUs as number) + d * speed) }
				: {}),
		};
	}
	const segments = [...track.segments];
	segments[segIndex] = patched;
	return replaceTrack(doc, track.id, { ...track, segments: sortSegs(segments) });
}

/**
 * 在时间轴绝对位置 atUs 处把片段切成两段。
 * ⚠ 素材唯一性（定稿，勿回退）：**绝不产生新素材实体**——两段引用同一 assetId，
 * source 窗口相邻互补：前段 source=[s, s+off)，后段 source=[s+off, s+总长)（off=切点相对偏移×speed）。
 * 切点在片段边界上（或距边界不足 MIN_SEGMENT_US）→ no-op 返回原 doc。
 */
export function splitSegment(doc: RtcDoc, segId: string, atUs: number): RtcDoc {
	const found = findSeg(doc, segId);
	if (!found) return doc;
	const { track, seg, segIndex } = found;
	const start = seg.targetStartUs;
	const end = segEnd(seg);
	if (atUs - start < MIN_SEGMENT_US || end - atUs < MIN_SEGMENT_US) return doc; // 边界 no-op
	const speed = seg.speed ?? 1;
	const withSource = hasSourceWindow(seg);
	const offsetUs = atUs - start;
	const srcOffsetUs = Math.round(offsetUs * speed);
	const left: RtcSegment = {
		...seg,
		targetDurationUs: offsetUs,
		...(withSource ? { sourceDurationUs: srcOffsetUs } : {}),
	};
	const right: RtcSegment = {
		...seg, // assetId/uri/name 等原样共享——引用同一素材源头
		id: genId("seg"),
		targetStartUs: atUs,
		targetDurationUs: end - atUs,
		...(withSource
			? {
				sourceStartUs: (seg.sourceStartUs as number) + srcOffsetUs,
				sourceDurationUs: (seg.sourceDurationUs as number) - srcOffsetUs,
			}
			: {}),
	};
	const segments = [...track.segments];
	segments.splice(segIndex, 1, left, right);
	return replaceTrack(doc, track.id, { ...track, segments });
}

/** 原位替换用的新素材描述（sourceTotalUs=新素材真实总长，探测不到给 0/缺省） */
export interface SegmentMediaReplacement {
	media: "image" | "video" | "audio";
	assetId?: string;
	uri?: string;
	name?: string;
	/** 新素材真实总长（微秒）；0/缺省=未知（不建 source 窗口，trim 不受虚假源长约束） */
	sourceTotalUs?: number;
}

/**
 * **原位替换**片段素材（剪映「替换」语义）：从素材区把素材拖到已有片段上时用。
 *
 * 定稿取舍：
 *   - `targetStartUs` **原样不动**（替换不挪位、不新增/删除片段——「不无缘无故增删」）；
 *   - `targetDurationUs` **保持原时长**；⚠ 仅当新素材真实总长撑不满原时长时才收到素材可用长度
 *     （否则片段尾部是没有画面的空转），钳不低于 MIN_SEGMENT_US；**只会变短不会变长**，
 *     所以绝不会与后一片段重叠，无需重新夹隙；
 *   - 图片素材不建 source 窗口（图片可任意拉伸，沿用拖放入轨的图片语义），时长原样保留；
 *   - 变速 speed / 音量 / shotRef / groupId 等原样保留；结果占位状态字段（status/progress/
 *     taskRef/error）随落成 media 一并清空；
 *   - 新素材没有 assetId 时**清掉旧 assetId**（否则导出会按旧素材去重，指向错的 material）。
 * 片段未找到返回原 doc 引用。
 */
export function replaceSegmentMedia(doc: RtcDoc, segId: string, next: SegmentMediaReplacement): RtcDoc {
	const found = findSeg(doc, segId);
	if (!found) return doc;
	const { track, seg, segIndex } = found;
	const speed = seg.speed ?? 1;
	const total = next.sourceTotalUs && next.sourceTotalUs > 0 ? next.sourceTotalUs : 0;

	let targetDurationUs = seg.targetDurationUs;
	let source: { sourceStartUs: number; sourceDurationUs: number } | null = null;
	if (next.media !== "image" && total > 0) {
		if (total < targetDurationUs * speed) {
			targetDurationUs = Math.max(MIN_SEGMENT_US, Math.floor(total / speed));
		}
		source = { sourceStartUs: 0, sourceDurationUs: Math.round(Math.min(total, targetDurationUs * speed)) };
	}

	const patched: RtcSegment = { ...seg, kind: "media", media: next.media, targetDurationUs };
	if (next.name) patched.name = next.name;
	if (next.assetId) patched.assetId = next.assetId;
	else delete patched.assetId;
	if (next.uri) patched.uri = next.uri;
	else delete patched.uri;
	if (source) {
		patched.sourceStartUs = source.sourceStartUs;
		patched.sourceDurationUs = source.sourceDurationUs;
	} else {
		delete patched.sourceStartUs;
		delete patched.sourceDurationUs;
	}
	delete patched.status;
	delete patched.progress;
	delete patched.taskRef;
	delete patched.error;

	const segments = [...track.segments];
	segments[segIndex] = patched;
	return replaceTrack(doc, track.id, { ...track, segments });
}

/**
 * **波纹删除**（剪映 Shift+Delete）：删除片段后，**同一轨道**上其右侧的片段整体左移补上空缺。
 *
 * 规则（定稿）：
 *   - 每条轨道各算各的——某轨survivor 左移量 = 该轨**位于它左侧的被删片段时长之和**
 *     （不是「贴到前一段屁股后面」）：片段之间原有的空隙原样保留，只把被删片段占的那段时间抽掉；
 *   - ⚠ **只影响被删片段所在的轨道，绝不动其它轨道**——跨轨波纹会打乱与音频/其它图层的对位
 *     （剪映默认行为亦是单轨）；
 *   - 不产生重叠也不会越过 0：被删片段两两不重叠且都在 survivor 左侧，抽掉的总量恒 ≤ survivor 起点，
 *     且相邻 survivor 的左移量差 ≤ 它们之间被删的总时长（数学上恒不相撞，见单测）。
 * 一个都没删到返回原 doc 引用。
 */
export function rippleDeleteSegments(doc: RtcDoc, ids: string[]): RtcDoc {
	const kill = new Set(ids);
	let changed = false;
	const tracks = doc.tracks.map((t) => {
		if (!t.segments.some((s) => kill.has(s.id))) return t; // 该轨没被删 → 原样（其它轨绝不受牵连）
		changed = true;
		let shift = 0; // 迄今扫过的被删片段总时长（都在后续片段左侧）
		const segments: RtcSegment[] = [];
		for (const s of sortSegs(t.segments)) {
			if (kill.has(s.id)) {
				shift += s.targetDurationUs;
				continue;
			}
			segments.push(shift > 0 ? { ...s, targetStartUs: Math.max(0, s.targetStartUs - shift) } : s);
		}
		return { ...t, segments };
	});
	return changed ? { ...doc, tracks } : doc;
}

/** 批量删除片段（跨轨道）；一个都没删到返回原 doc */
export function removeSegments(doc: RtcDoc, ids: string[]): RtcDoc {
	const kill = new Set(ids);
	let changed = false;
	const tracks = doc.tracks.map((t) => {
		const segments = t.segments.filter((s) => !kill.has(s.id));
		if (segments.length === t.segments.length) return t;
		changed = true;
		return { ...t, segments };
	});
	return changed ? { ...doc, tracks } : doc;
}

/** 粘贴一条片段的落位描述（调用方按剪贴板条目现做，见 rtc/timeline/rtcClipboardCore） */
export interface RtcPasteEntry {
	/** 待放置的片段——**已带最终 id**（调用方 genId 后传入：它要拿这批 id 去设选中态）；
	 *  ⚠ 素材唯一性：assetId 原样共享，副本与原片段引用同一素材，绝不产生新素材实体 */
	seg: RtcSegment;
	/** 复制来源轨道 id：仍在、类型相符且未锁 → 优先落回原轨（保住图层关系） */
	trackId?: string;
	trackType: RtcTrackType;
	/** 相对锚点的时间偏移——整批粘贴时**保持片段之间的相对时间关系** */
	offsetUs: number;
}

/**
 * 批量粘贴片段到 atUs 锚点（剪映 Ctrl+V 语义）。
 *
 * 落位规则（定稿）：
 *   - 起点 = `atUs + entry.offsetUs`（偏移=复制时相对最早片段的距离，故整批的相对关系原样保持）；
 *   - 轨道 = 原轨（仍在 / 类型相符 / 未锁）→ 首条同类型未锁轨 → 都没有则**新建**一条同类型轨
 *     （经 insertTrackAt，主轨不变量照旧：新 video 轨恒在主轨之后）；
 *   - 落点被占 → 走 addSegment 的**夹到最近空隙**（既有语义，绝不推挤既有片段）；⚠ 被夹住的那条
 *     与同批其余片段的相对关系会随之偏离，这是「不推挤」的必然代价。
 *   - 逐条顺序放置：同批多条落同一轨时，后一条能看见前一条已占的位置，不会互相重叠。
 * 空清单返回原 doc 引用。
 */
export function pasteSegments(doc: RtcDoc, entries: RtcPasteEntry[], atUs: number): RtcDoc {
	if (entries.length === 0) return doc;
	const anchor = Math.max(0, Math.round(atUs));
	let next = doc;
	for (const e of entries) {
		let track = e.trackId ? next.tracks.find((t) => t.id === e.trackId) : undefined;
		if (!track || track.type !== e.trackType || track.locked) {
			track = next.tracks.find((t) => t.type === e.trackType && !t.locked);
		}
		let trackId = track?.id;
		if (!trackId) {
			trackId = genId("track");
			next = insertTrackAt(next, e.trackType, groupEndIndex(next.tracks, e.trackType), { id: trackId });
		}
		next = addSegment(next, trackId, {
			...e.seg,
			targetStartUs: anchor + Math.max(0, Math.round(e.offsetUs)),
		});
	}
	return next;
}

/* ────────────────────────── 查询 ────────────────────────── */

/** 文档总时长（微秒）＝所有片段的最大右缘；空文档为 0 */
export function docDurationUs(doc: RtcDoc): number {
	let max = 0;
	for (const t of doc.tracks) for (const s of t.segments) max = Math.max(max, segEnd(s));
	return max;
}

/**
 * 磁吸候选（供 UI 用）：所有片段边界（排除 excludeIds，通常是拖动中的片段）+ 整秒刻度
 * （0 起、覆盖到候选边界最大值的下一整秒）。返回升序去重数组（微秒）。
 */
export function snapCandidates(doc: RtcDoc, excludeIds: string[] = []): number[] {
	const exclude = new Set(excludeIds);
	const out = new Set<number>();
	let maxEnd = 0;
	for (const t of doc.tracks) {
		for (const s of t.segments) {
			if (exclude.has(s.id)) continue;
			out.add(s.targetStartUs);
			out.add(segEnd(s));
			maxEnd = Math.max(maxEnd, segEnd(s));
		}
	}
	const lastTick = Math.ceil(maxEnd / US_PER_SEC);
	for (let sec = 0; sec <= lastTick; sec++) out.add(sec * US_PER_SEC);
	return [...out].sort((a, b) => a - b);
}

/* ────────────────────────── 时间轴 UI 纯函数 ────────────────────────── */

/** 升序候选数组中距 valueUs 最近且差 ≤ thresholdUs 的候选（二分定位）；无命中返回 null */
export function nearestSnap(candidates: number[], valueUs: number, thresholdUs: number): number | null {
	if (candidates.length === 0) return null;
	let lo = 0;
	let hi = candidates.length - 1;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (candidates[mid] < valueUs) lo = mid + 1;
		else hi = mid;
	}
	let best: number | null = null;
	let bestDist = Infinity;
	for (const i of [lo - 1, lo, lo + 1]) {
		const c = candidates[i];
		if (c == null) continue;
		const d = Math.abs(c - valueUs);
		if (d < bestDist) {
			bestDist = d;
			best = c;
		}
	}
	return best != null && bestDist <= thresholdUs ? best : null;
}

/** 拖动吸附：片段首/尾两缘各自试吸附，取更近的一缘换算回起点；均无命中返回原 desiredStartUs */
export function snapSegmentStart(
	candidates: number[],
	desiredStartUs: number,
	durUs: number,
	thresholdUs: number,
): number {
	const atStart = nearestSnap(candidates, desiredStartUs, thresholdUs);
	const atEnd = nearestSnap(candidates, desiredStartUs + durUs, thresholdUs);
	const dStart = atStart != null ? Math.abs(atStart - desiredStartUs) : Infinity;
	const dEnd = atEnd != null ? Math.abs(atEnd - (desiredStartUs + durUs)) : Infinity;
	if (dStart === Infinity && dEnd === Infinity) return desiredStartUs;
	return dStart <= dEnd ? (atStart as number) : (atEnd as number) - durUs;
}

/** 标尺主刻度步长（微秒）：1s/5s/10s/30s/1m 档中取「主刻度间距 ≥ 64px」的最小档；全不满足取 1m */
export function rulerStepUs(pxPerSec: number): number {
	for (const sec of [1, 5, 10, 30, 60]) {
		if (sec * pxPerSec >= 64) return sec * US_PER_SEC;
	}
	return 60 * US_PER_SEC;
}

/** HH:MM:SS.ff 时间码（ff=帧号按 fps；fps 非法回退 30） */
export function formatTimecode(us: number, fps = 30): string {
	const f = Number.isFinite(fps) && fps > 0 ? fps : 30;
	const totalSec = Math.max(0, us) / US_PER_SEC;
	const h = Math.floor(totalSec / 3600);
	const m = Math.floor((totalSec % 3600) / 60);
	const s = Math.floor(totalSec % 60);
	// 帧号夹在 [0, f-1]：末尾浮点误差不产生 "30" 帧
	const frame = Math.min(f - 1, Math.floor((totalSec - Math.floor(totalSec)) * f));
	const p = (n: number) => String(n).padStart(2, "0");
	return `${p(h)}:${p(m)}:${p(s)}.${p(frame)}`;
}

/** 一帧的微秒数（走带快捷键 ←/→ 的步长；fps 非法回退 30，下限 1μs 防除零） */
export function frameDurationUs(fps: number): number {
	const f = Number.isFinite(fps) && fps > 0 ? fps : 30;
	return Math.max(1, Math.round(US_PER_SEC / f));
}

/** 播放头步进：currentUs + deltaUs 后钳到 [0, durationUs]（与 rtcStore.clampPlayheadUs 同口径） */
export function stepPlayheadUs(currentUs: number, deltaUs: number, durationUs: number): number {
	const max = Math.max(0, Number.isFinite(durationUs) ? durationUs : 0);
	const cur = Number.isFinite(currentUs) ? currentUs : 0;
	const d = Number.isFinite(deltaUs) ? deltaUs : 0;
	return Math.min(max, Math.max(0, Math.round(cur + d)));
}

/**
 * 解析用户输入的时间 → 微秒（属性面板的时间码/时长输入框用）。接受两种形态：
 *   - **秒数**："6"、"6.3"、"6.3s"、"6.3秒"（尾随单位容忍）；
 *   - **时间码**："0:06.3"（分:秒）、"1:02:03.5"（时:分:秒）；全角冒号一并接受。
 *
 * ⚠ 小数位一律按**十进制秒**解释（不是帧号）——与属性面板显示用的 fmtUs 同一口径，
 *   输入输出可原样往返；`formatTimecode` 的 ".ff" 是帧号，别把两者混着往这里喂。
 * 非法 / 负数 / 空串 / 超过 3 段 / 非末位带小数 → 返回 null（调用方回退原值，不报错）。
 */
export function parseTimecodeInput(text: string): number | null {
	if (typeof text !== "string") return null;
	const raw = text.trim().replace(/：/g, ":").replace(/(s|S|秒)$/, "").trim();
	if (!raw) return null;
	const parts = raw.split(":");
	if (parts.length > 3) return null;
	let total = 0;
	for (let i = 0; i < parts.length; i++) {
		const p = parts[i].trim();
		if (!/^(\d+(\.\d+)?|\.\d+)$/.test(p)) return null;
		const n = Number(p);
		if (!Number.isFinite(n)) return null;
		if (i < parts.length - 1 && !Number.isInteger(n)) return null; // 时/分段不接受小数
		total = total * 60 + n;
	}
	if (!Number.isFinite(total)) return null;
	return Math.round(total * US_PER_SEC);
}

/**
 * 时间输入框的显示格式，与 `parseTimecodeInput` **互为逆运算**（原样往返）：
 * `m:ss.dd`（不足 1 小时）/ `h:mm:ss.dd`。小数=十进制秒的百分位（10ms 精度，够摆位用）。
 * ⚠ 与 `formatTimecode`（HH:MM:SS.**帧号**）是两套口径，别混用：那套给播放头读数，这套给可编辑输入。
 */
export function formatEditableTime(us: number): string {
	const totalSec = Math.max(0, Math.round(Math.max(0, us) / 10_000) / 100); // 先归到 10ms 网格再拆位
	const h = Math.floor(totalSec / 3600);
	const m = Math.floor((totalSec % 3600) / 60);
	const s = totalSec % 60;
	const sec = s.toFixed(2).padStart(5, "0");
	return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** 素材媒体类型 → 轨道类型（视频/图片落 video 轨，音频落 audio 轨） */
export function trackTypeForMedia(media: "image" | "video" | "audio"): RtcTrackType {
	return media === "audio" ? "audio" : "video";
}

/* ────────────────────────── 批量分割 / 播放头选择与裁剪 / 分割点导航 / 组合（第238轮·批次1） ────────────────────────── */

/**
 * 批量分割（Ctrl+B）：**全部未锁定轨道**上跨过 atUs 的 media 片段各切一刀。
 * 复用 splitSegment 语义（绝不复制素材实体；贴边/距边不足 MIN_SEGMENT_US 的片段天然 no-op）；
 * 占位片段刻意不切（占位=生成坑位，一切两半会让 taskRef 落笔无所适从）。
 * 一刀都没切到返回原 doc 引用。
 */
export function splitAllAtPlayhead(doc: RtcDoc, atUs: number): RtcDoc {
	let next = doc;
	for (const t of doc.tracks) {
		if (t.locked) continue;
		for (const s of t.segments) {
			if (s.kind !== "media") continue;
			// 先粗判跨过切点再调 splitSegment（左段 id 不变，逐条 reduce 安全）
			if (atUs - s.targetStartUs >= MIN_SEGMENT_US && segEnd(s) - atUs >= MIN_SEGMENT_US) {
				next = splitSegment(next, s.id, atUs);
			}
		}
	}
	return next;
}

/**
 * 播放头某一侧的片段 id（向左/向右全选 [ / ] 用）：
 * left = 起点严格早于播放头；right = 终点严格晚于播放头（跨过播放头的片段两侧都算——剪映同语义）。
 * 锁定轨道跳过（选中它们也动不了，反而挡住批量操作）。
 */
export function segmentIdsSideOf(doc: RtcDoc, atUs: number, side: "left" | "right"): string[] {
	const out: string[] = [];
	for (const t of doc.tracks) {
		if (t.locked) continue;
		for (const s of t.segments) {
			if (side === "left" ? s.targetStartUs < atUs : segEnd(s) > atUs) out.push(s.id);
		}
	}
	return out;
}

/**
 * 把片段某一缘裁到播放头（Q / W）：仅当 atUs 严格落在片段时间窗内才生效——
 * edge="start" 左缘右收到播放头（保留右半），edge="end" 右缘左收到播放头（保留左半）。
 * 两个方向都是**收缩**（不会外扩），无需源素材总长约束；锁定轨道 / 播放头在窗外 → 原 doc 引用。
 */
export function trimSegmentToPlayhead(doc: RtcDoc, segId: string, edge: "start" | "end", atUs: number): RtcDoc {
	const found = findSeg(doc, segId);
	if (!found) return doc;
	if (found.track.locked) return doc;
	const start = found.seg.targetStartUs;
	const end = segEnd(found.seg);
	if (!(atUs > start && atUs < end)) return doc;
	return trimSegment(doc, segId, edge, edge === "start" ? atUs - start : atUs - end);
}

/**
 * 剪辑点集合（上/下一分割点 ↑/↓ 的落点）：0 + 全部片段首尾边界，升序去重。
 * ⚠ 刻意**不复用 snapCandidates**：那份候选混着整秒刻度（磁吸要吸整秒），
 *   「跳到分割点」只该停在真实剪辑边界上，混进整秒会一路一秒一秒地挪。
 */
export function cutPoints(doc: RtcDoc): number[] {
	const set = new Set<number>([0]);
	for (const t of doc.tracks) {
		for (const s of t.segments) {
			set.add(s.targetStartUs);
			set.add(segEnd(s));
		}
	}
	return [...set].sort((a, b) => a - b);
}

/** 升序剪辑点里找 fromUs 的下一个（dir=1）/上一个（dir=-1）**严格**相邻点；没有返回 null */
export function nextCutPoint(points: number[], fromUs: number, dir: 1 | -1): number | null {
	if (dir > 0) {
		for (const p of points) if (p > fromUs) return p;
		return null;
	}
	for (let i = points.length - 1; i >= 0; i--) if (points[i] < fromUs) return points[i];
	return null;
}

/**
 * 创建组合（Ctrl+G）：给一批片段分配同一 groupId（跨轨允许；已在别的组的片段改投新组）。
 * 命中片段 <2 个=没有组可言，no-op 返回原 doc 引用。groupId 可注入（单测断言用），缺省 genId。
 */
export function groupSegments(doc: RtcDoc, ids: string[], groupId?: string): RtcDoc {
	const want = new Set(ids);
	let count = 0;
	for (const t of doc.tracks) for (const s of t.segments) if (want.has(s.id)) count++;
	if (count < 2) return doc;
	const gid = groupId ?? genId("grp");
	return {
		...doc,
		tracks: doc.tracks.map((t) => {
			if (!t.segments.some((s) => want.has(s.id))) return t;
			return { ...t, segments: t.segments.map((s) => (want.has(s.id) ? { ...s, groupId: gid } : s)) };
		}),
	};
}

/**
 * 解除组合（Ctrl+Shift+G）：ids 命中的片段所属的**整个组**全部解散
 * （选中天然是整组——见 expandSelectionWithGroups；按组解散防出现「半个组」的残缺状态）。
 * 没解到任何组返回原 doc 引用。
 */
export function ungroupSegments(doc: RtcDoc, ids: string[]): RtcDoc {
	const want = new Set(ids);
	const gids = new Set<string>();
	for (const t of doc.tracks) {
		for (const s of t.segments) {
			if (want.has(s.id) && s.groupId) gids.add(s.groupId);
		}
	}
	if (gids.size === 0) return doc;
	return {
		...doc,
		tracks: doc.tracks.map((t) => {
			if (!t.segments.some((s) => s.groupId && gids.has(s.groupId))) return t;
			return {
				...t,
				segments: t.segments.map((s) => {
					if (!s.groupId || !gids.has(s.groupId)) return s;
					const { groupId: _drop, ...rest } = s;
					return rest;
				}),
			};
		}),
	};
}

/**
 * 选区按组扩张：ids 里任一片段带 groupId → 把同组其余片段一并纳入（时间轴点击选中整组、
 * 删除/复制/剪切天然作用于整组都靠它）。没有可补的成员返回**原数组引用**（防无谓 setState）。
 */
export function expandSelectionWithGroups(doc: RtcDoc, ids: string[]): string[] {
	const have = new Set(ids);
	const gids = new Set<string>();
	for (const t of doc.tracks) {
		for (const s of t.segments) {
			if (have.has(s.id) && s.groupId) gids.add(s.groupId);
		}
	}
	if (gids.size === 0) return ids;
	const extra: string[] = [];
	for (const t of doc.tracks) {
		for (const s of t.segments) {
			if (s.groupId && gids.has(s.groupId) && !have.has(s.id)) extra.push(s.id);
		}
	}
	return extra.length ? [...ids, ...extra] : ids;
}

/* ────────────────────────── 第二批：定格（freeze frame） ────────────────────────── */

/** 定格图片片段的默认时长（微秒）：3 秒 */
export const FREEZE_DEFAULT_US = 3_000_000;

/** 定格插入的图片素材描述（帧已抽好、字节已落本地资产——见 rtc/timeline/rtcFreezeActions） */
export interface FreezeStill {
	/** 新图片片段 id（调用方 genId 后传入，便于随后设选中态）；缺省内部生成 */
	id?: string;
	assetId?: string;
	uri?: string;
	name?: string;
	/** 定格时长（微秒，缺省 FREEZE_DEFAULT_US；下限 MIN_SEGMENT_US） */
	durUs?: number;
}

/**
 * **定格**：原片段在时间轴绝对位置 atUs 处分割，两半之间插入 durUs 的图片片段，
 * **同轨右侧片段整体右移 durUs**（原有空隙原样保留，绝不吞并）。一次调用产出一个新 doc =
 * 一次 commit = 一条 undo（调用方经 rtcStore.commit 提交）。
 *
 * ⚠ 素材唯一性（§9A）：分割沿用 splitSegment 语义——两半引用**同一 assetId**、source 窗口相邻互补，
 *   绝不产生新素材实体；定格图片是**另一个素材**（抽帧产物），有它自己的 assetId。
 * ⚠ 关键帧分账：原片段的 keyframes 经 splitKeyframes 切给两半（右半 t 平移；跨切点补采样边界帧），
 *   分割前后动画逐帧不变；定格图片片段继承原片段的 transform（画面接得上），不继承关键帧。
 * 切点不在片段内部（距两缘不足 MIN_SEGMENT_US）/ 片段未找到 → 返回原 doc 引用（no-op）。
 */
export function insertFreezeFrame(doc: RtcDoc, segId: string, atUs: number, still: FreezeStill): RtcDoc {
	const found = findSeg(doc, segId);
	if (!found) return doc;
	const { track, seg } = found;
	const start = seg.targetStartUs;
	const end = segEnd(seg);
	if (atUs - start < MIN_SEGMENT_US || end - atUs < MIN_SEGMENT_US) return doc; // 切点须在片段内部
	const durUs = Math.max(MIN_SEGMENT_US, Math.round(still.durUs ?? FREEZE_DEFAULT_US));
	const speed = seg.speed ?? 1;
	const withSource = hasSourceWindow(seg);
	const offsetUs = atUs - start;
	const srcOffsetUs = Math.round(offsetUs * speed);
	const [kfLeft, kfRight] = splitKeyframes(seg.keyframes, offsetUs);

	const left: RtcSegment = {
		...seg,
		targetDurationUs: offsetUs,
		...(withSource ? { sourceDurationUs: srcOffsetUs } : {}),
	};
	if (kfLeft) left.keyframes = kfLeft;
	else delete left.keyframes;

	// 定格图片片段：图片无 source 窗口；继承 transform（视觉与被定格的帧无缝衔接）
	const stillSeg: RtcSegment = {
		id: still.id || genId("seg"),
		kind: "media",
		media: "image",
		...(still.name ? { name: still.name } : {}),
		...(still.assetId ? { assetId: still.assetId } : {}),
		...(still.uri ? { uri: still.uri } : {}),
		...(seg.transform ? { transform: seg.transform } : {}),
		targetStartUs: atUs,
		targetDurationUs: durUs,
	};

	const right: RtcSegment = {
		...seg, // assetId/uri/name 原样共享——引用同一素材源头（绝不复制素材）
		id: genId("seg"),
		targetStartUs: atUs + durUs,
		targetDurationUs: end - atUs,
		...(withSource
			? {
				sourceStartUs: (seg.sourceStartUs as number) + srcOffsetUs,
				sourceDurationUs: (seg.sourceDurationUs as number) - srcOffsetUs,
			}
			: {}),
	};
	if (kfRight) right.keyframes = kfRight;
	else delete right.keyframes;

	// 同轨右侧片段整体右移 durUs（它们的起点必 ≥ 原片段右缘 ≥ atUs，平移量一致 → 不会产生重叠）
	const segments: RtcSegment[] = [];
	for (const s of track.segments) {
		if (s.id === segId) continue;
		segments.push(s.targetStartUs >= atUs ? { ...s, targetStartUs: s.targetStartUs + durUs } : s);
	}
	segments.push(left, stillSeg, right);
	return replaceTrack(doc, track.id, { ...track, segments: sortSegs(segments) });
}

/* ── 第三批：倒放/裁剪/字幕/转场 ── */

/** 倒放换素材的描述（正向→倒放 与 倒放→还原 共用同一形状） */
export interface ReverseSwap {
	/** 换入素材的 assetId / 显示 uri（undefined=清除对应字段） */
	assetId?: string;
	uri?: string;
	/** 换入素材的总时长（微秒）；0/缺省=未知（source 窗口起点归 0，见下） */
	totalUs?: number;
	/** 倒放标记：正向→倒放 传**原素材** assetId；倒放→还原 传 undefined（清除标记） */
	reversedFromAssetId?: string;
}

/**
 * 倒放换素材（纯函数）：把片段的素材引用换成倒放副本（或换回原素材），并做 **source 窗口镜像换算**。
 *
 * 镜像语义：物理倒放后素材时间轴整体反向——原素材的窗口 [s, s+d) 在倒放副本里对应
 * [total − (s+d), total − s)，即 **新 sourceStart = total − 旧 sourceEnd**、时长不变；
 * 还原时再镜像一次即回到原窗口（total 相同，两次镜像互逆——单测锁定）。
 * 素材总时长探测不到（totalUs 0/缺省）→ 起点归 0（时长保持，宁可从头放也不写负起点）。
 *
 * ⚠ 只动 assetId/uri/reversedFromAssetId/sourceStartUs——target 位置/时长、speed、音量等一概不动；
 * 无 source 窗口的片段（图片等）只换引用不动窗口。片段不存在/非 media → 原 doc 引用（no-op）。
 */
export function applyReverse(doc: RtcDoc, segId: string, swap: ReverseSwap): RtcDoc {
	const found = findSeg(doc, segId);
	if (!found) return doc;
	const { track, seg, segIndex } = found;
	if (seg.kind !== "media") return doc;

	const patched: RtcSegment = { ...seg };
	if (swap.assetId) patched.assetId = swap.assetId;
	else delete patched.assetId;
	if (swap.uri) patched.uri = swap.uri;
	else delete patched.uri;
	if (swap.reversedFromAssetId) patched.reversedFromAssetId = swap.reversedFromAssetId;
	else delete patched.reversedFromAssetId;

	if (seg.sourceStartUs != null && seg.sourceDurationUs != null) {
		const total = swap.totalUs && swap.totalUs > 0 ? Math.round(swap.totalUs) : 0;
		const end = seg.sourceStartUs + seg.sourceDurationUs;
		patched.sourceStartUs = total > 0 ? Math.max(0, Math.round(total - end)) : 0;
		// sourceDurationUs 不变（倒放不改片段取用的时长）
	}

	const segments = [...track.segments];
	segments[segIndex] = patched;
	return replaceTrack(doc, track.id, { ...track, segments });
}

/* ────────────────────────── 空轨道自动回收（用户定：一个时间轨上没有素材时自动回收） ────────────────────────── */

/**
 * 清掉**空轨道**：片段被移走/删除/并入复合后留下的空轨自动消失（对标剪映）。
 * ⚠ 三类空轨**保留**：主轨（第一条 video 轨——画幅骨架恒在）、锁定轨（用户显式锁=显式意图）、
 *   以及「删完会一条轨都不剩」时的第一条轨（时间轴不空壳）。
 * 只在**移出/删除类动作的收尾**调用（勿挂进 commit 管道——工具栏「+视频轨」刚建的空轨会被当场收走）。
 * 无可清返回原引用（commit 语义友好）。
 */
export function pruneEmptyTracks(doc: RtcDoc): RtcDoc {
	const mainId = doc.tracks.find((t) => t.type === "video")?.id ?? null;
	const kept = doc.tracks.filter((t) => t.segments.length > 0 || t.id === mainId || t.locked);
	if (kept.length === doc.tracks.length) return doc;
	if (kept.length === 0 && doc.tracks.length > 0) return { ...doc, tracks: [doc.tracks[0]] };
	return { ...doc, tracks: kept };
}
