/**
 * rtcCompound.ts — 复合片段（子时间轴）纯函数操作（第四批，全部可单测、零 store/DOM 依赖）。
 *
 * 语义定稿（与 docs/剪映复合片段草稿结构.md、types/rtc.ts 注释同源）：
 *   - 复合片段 = 一段引用子时间轴（RtcDoc.subDocs[subDocId]）的 segment（kind:"compound"）；
 *     **与素材引用同构**：source 窗口 = 子时间轴时间窗；分割/复制共享同一 subDocId，绝不复制 subDoc；
 *   - 嵌套深度 1（P0）：子文档内不允许再有 compound（createCompound 拒绝把 compound 选进去；
 *     sanitize 把子文档里的嵌套 compound 降级为占位符）；
 *   - 子层编辑改变子时长后，引用它的 compound 片段 target/source 窗口**不自动变**（与素材裁剪同语义：
 *     子内容变长 = 尾部被窗口裁掉；变短 = 窗口尾部空放）。
 *
 * 不变量沿用 rtcOps：无效输入返回**原 doc 引用**；落位绝不推挤既有片段。
 */
import { genId } from "./id";
import type { RtcDoc, RtcSegment, RtcSubDoc, RtcTrack } from "@/types/rtc";
import { insertTrackAt, orderTracksForDisplay } from "./rtcOps";

function segEnd(s: RtcSegment): number {
	return s.targetStartUs + s.targetDurationUs;
}

function sortSegs(segs: RtcSegment[]): RtcSegment[] {
	return [...segs].sort((a, b) => a.targetStartUs - b.targetStartUs);
}

/** 子时间轴总时长（微秒）= 全部片段最大右缘（与 rtcOps.docDurationUs 同口径，收在这里防依赖倒挂） */
export function subDocDurationUs(sub: Pick<RtcSubDoc, "tracks">): number {
	let max = 0;
	for (const t of sub.tracks) for (const s of t.segments) max = Math.max(max, segEnd(s));
	return max;
}

/** 复合片段命名：现有子文档数 +1（「复合片段N」） */
export function nextCompoundName(doc: RtcDoc): string {
	return `复合片段${Object.keys(doc.subDocs ?? {}).length + 1}`;
}

/* ────────────────────────── 创建 / 解散 ────────────────────────── */

export interface CreateCompoundOptions {
	/** 复合片段 id（调用方 genId 后传入即可拿它设选中态；缺省内部生成） */
	segId?: string;
	/** 子文档 id（缺省内部生成） */
	subDocId?: string;
	name?: string;
}

/**
 * 把选中的 media 片段（≥1，可跨轨）打包成一个复合片段：
 *   - 选中片段**移入**新子文档（保持相对时间与轨道结构，整体左移到 0 起）；
 *   - 原位替换为一个 compound 片段：落在**选区最上层片段所在轨**（显示序最上），
 *     target = 选区包络 [min起点, max终点)，source 窗口 = [0, 子时长)；
 *   - 其余被移走的位置留空（不折叠不推挤）。
 *
 * 拒绝条件（返回原 doc 引用）：选区为空 / 任一 id 找不到 / 含 placeholder（占位符不入复合）
 * / 含 compound（嵌套深度 1，复合内不再嵌复合）。
 *
 * 边界：compound 期望落点（选区包络起点）被宿主轨上**未选中**的片段占住时，按 rtcOps
 * 「夹到最近空隙」语义落位（绝不推挤）——此时 compound 的时间轴位置会偏离包络起点。
 */
export function createCompound(doc: RtcDoc, segIds: string[], opts?: CreateCompoundOptions): RtcDoc {
	if (segIds.length === 0) return doc;
	const wanted = new Set(segIds);
	/** trackId → 该轨被选中的片段（保持 doc.tracks 顺序收集） */
	const picked = new Map<string, RtcSegment[]>();
	let found = 0;
	for (const t of doc.tracks) {
		for (const s of t.segments) {
			if (!wanted.has(s.id)) continue;
			found++;
			if (s.kind !== "media") return doc; // 占位符/复合片段一律拒绝（嵌套深度 1）
			const list = picked.get(t.id) ?? [];
			list.push(s);
			picked.set(t.id, list);
		}
	}
	if (found !== wanted.size) return doc; // 有 id 找不到（选区脏了）→ no-op

	// 选区包络
	let minStart = Infinity;
	let maxEnd = 0;
	for (const list of picked.values()) {
		for (const s of list) {
			minStart = Math.min(minStart, s.targetStartUs);
			maxEnd = Math.max(maxEnd, segEnd(s));
		}
	}
	if (!(maxEnd > minStart)) return doc;
	const spanUs = maxEnd - minStart;

	// 子文档：按 doc.tracks 顺序为每条含选中片段的轨道建一条子轨（新 id，防主/子轨道 id 撞车），
	// 片段整体左移 minStart（保持相对时间与轨道结构）
	const subTracks: RtcTrack[] = [];
	for (const t of doc.tracks) {
		const list = picked.get(t.id);
		if (!list) continue;
		subTracks.push({
			id: genId("track"),
			type: t.type,
			...(t.name ? { name: t.name } : {}),
			...(t.muted ? { muted: true } : {}),
			segments: sortSegs(list).map((s) => ({ ...s, targetStartUs: s.targetStartUs - minStart })),
		});
	}
	const subDocId = opts?.subDocId ?? genId("sub");
	const sub: RtcSubDoc = { id: subDocId, name: opts?.name ?? nextCompoundName(doc), tracks: subTracks };

	// 宿主轨 = 选区**最上层**片段所在轨（显示序：orderTracksForDisplay 从上到下，取第一条含选中的）
	const hostId = orderTracksForDisplay(doc.tracks).find((t) => picked.has(t.id))?.id;
	if (!hostId) return doc;

	const compoundSeg: RtcSegment = {
		id: opts?.segId ?? genId("seg"),
		kind: "compound",
		subDocId,
		name: sub.name,
		targetStartUs: minStart,
		targetDurationUs: spanUs,
		sourceStartUs: 0,
		sourceDurationUs: spanUs,
	};

	// 选中片段全部移走 + compound 落宿主轨（期望位置被未选中片段占住则夹到最近空隙——复用既有语义）
	const tracks = doc.tracks.map((t) => {
		const segments = t.segments.filter((s) => !wanted.has(s.id));
		return segments.length === t.segments.length ? t : { ...t, segments };
	});
	let next: RtcDoc = { ...doc, tracks, subDocs: { ...doc.subDocs, [subDocId]: sub } };
	// addSegment 会夹隙 + 排序（在移除选中之后的宿主轨上找空隙）
	// 这里内联 rtcOps.addSegment 语义以避免时长钳位差异（span 恒 ≥ MIN_SEGMENT_US，因为源片段本就合法）
	const host = next.tracks.find((t) => t.id === hostId)!;
	const start = clampToNearestGap(host.segments, spanUs, minStart);
	next = {
		...next,
		tracks: next.tracks.map((t) =>
			t.id === hostId
				? { ...t, segments: sortSegs([...t.segments, { ...compoundSeg, targetStartUs: start }]) }
				: t,
		),
	};
	return next;
}

/** 与 rtcOps.clampToNearestGap 同语义（那边未导出；行为由双方单测各自锁定） */
function clampToNearestGap(others: RtcSegment[], durUs: number, desiredUs: number): number {
	const sorted = sortSegs(others);
	const desired = Math.max(0, desiredUs);
	const gaps: Array<{ lo: number; hi: number }> = [];
	let cursor = 0;
	for (const s of sorted) {
		if (s.targetStartUs - cursor >= durUs) gaps.push({ lo: cursor, hi: s.targetStartUs - durUs });
		cursor = Math.max(cursor, segEnd(s));
	}
	gaps.push({ lo: cursor, hi: Infinity });
	let best = gaps[gaps.length - 1].lo;
	let bestCost = Infinity;
	for (const g of gaps) {
		const candidate = Math.min(Math.max(desired, g.lo), g.hi);
		const cost = Math.abs(candidate - desired);
		if (cost < bestCost) {
			bestCost = cost;
			best = candidate;
		}
	}
	return best;
}

/** [有序不重叠的 existing] 能否原位容纳 incoming（两两不重叠、按位放置不动任何片段） */
function fitsAll(existing: RtcSegment[], incoming: RtcSegment[]): boolean {
	const all = [...existing, ...incoming].sort((a, b) => a.targetStartUs - b.targetStartUs);
	for (let i = 1; i < all.length; i++) {
		if (all[i].targetStartUs < segEnd(all[i - 1])) return false;
	}
	return incoming.every((s) => s.targetStartUs >= 0);
}

/**
 * 解散复合片段：子时间轴片段按 compound 的 **target 起点**平移回主时间轴，
 * 删除 compound 片段；子文档没有其它引用（分割共享）时一并删除。
 *
 * 落轨规则（逐条子轨原子放置，保住子轨内片段的相对关系）：
 *   ① 宿主轨类型相符且整条子轨都放得下 → 落宿主轨；
 *   ② 否则按 doc.tracks 顺序找首条同类型、未锁、整条放得下的轨；
 *   ③ 都放不下 → 新建一条同类型轨（insertTrackAt 组末端，主轨不变量照旧）。
 *
 * 已知边界（报告注明）：解散按 target 起点整体平移，**忽略 source 窗口的裁剪偏移**——
 * 被裁剪过的复合片段解散后恢复的是子时间轴全部内容（起点对齐 compound 起点）。
 * 子文档仍被其它分割片段引用时，恢复的片段使用**新 id**（防主/子两处同 id 并存）。
 */
export function dissolveCompound(doc: RtcDoc, segId: string): RtcDoc {
	let hostTrackId: string | null = null;
	let seg: RtcSegment | null = null;
	for (const t of doc.tracks) {
		const s = t.segments.find((x) => x.id === segId);
		if (s) {
			hostTrackId = t.id;
			seg = s;
			break;
		}
	}
	if (!seg || !hostTrackId || seg.kind !== "compound" || !seg.subDocId) return doc;
	const sub = doc.subDocs?.[seg.subDocId];
	if (!sub) return doc;
	const offset = seg.targetStartUs;

	// 其它片段是否还引用同一子文档（分割产生的共享）
	let otherRefs = 0;
	for (const t of doc.tracks) {
		for (const s of t.segments) {
			if (s.id !== segId && s.kind === "compound" && s.subDocId === seg.subDocId) otherRefs++;
		}
	}
	const reId = otherRefs > 0; // 共享未解除 → 恢复片段换新 id，防 id 在主/子两处并存

	// 先移除 compound 本体
	let tracks = doc.tracks.map((t) =>
		t.id === hostTrackId ? { ...t, segments: t.segments.filter((s) => s.id !== segId) } : t,
	);
	let next: RtcDoc = { ...doc, tracks };

	for (const st of sub.tracks) {
		if (st.segments.length === 0) continue;
		const shifted = sortSegs(st.segments).map((s) => ({
			...s,
			...(reId ? { id: genId("seg") } : {}),
			targetStartUs: s.targetStartUs + offset,
		}));
		// ① 宿主轨优先（类型相符）② 首条放得下的同类型未锁轨 ③ 新建
		const candidates = [
			...(next.tracks.filter((t) => t.id === hostTrackId && t.type === st.type)),
			...next.tracks.filter((t) => t.id !== hostTrackId && t.type === st.type && !t.locked),
		];
		const target = candidates.find((t) => fitsAll(t.segments, shifted));
		if (target) {
			next = {
				...next,
				tracks: next.tracks.map((t) =>
					t.id === target.id ? { ...t, segments: sortSegs([...t.segments, ...shifted]) } : t,
				),
			};
		} else {
			const newId = genId("track");
			next = insertTrackAt(next, st.type, next.tracks.length, { id: newId, name: st.name });
			next = {
				...next,
				tracks: next.tracks.map((t) => (t.id === newId ? { ...t, segments: shifted } : t)),
			};
		}
	}

	// 无其它引用 → 删除子文档（空表则整键摘除）
	if (!reId) {
		const rest = { ...next.subDocs };
		delete rest[seg.subDocId];
		next = Object.keys(rest).length > 0 ? { ...next, subDocs: rest } : stripSubDocs(next);
	}
	return next;
}

function stripSubDocs(doc: RtcDoc): RtcDoc {
	if (!("subDocs" in doc)) return doc;
	const { subDocs: _drop, ...rest } = doc;
	void _drop;
	return rest as RtcDoc;
}

/* ────────────────────────── 载入清洗 ────────────────────────── */

/**
 * rtcDoc 载入清洗（rtcStore.loadDoc / 外部镜像收编时调用；无复合内容时**返回原引用**零开销）：
 *   ① subDocs 形状清洗：非对象/缺 tracks 的条目剔除；
 *   ② 嵌套深度 1：子文档轨道上的 compound 片段**降级为占位符**（摘除 subDocId）；
 *   ③ 主轨道上引用缺失子文档的 compound 片段**降级为占位符**（保留时间与名称，不静默删）；
 *   ④ 孤儿子文档（无任何片段引用）剔除；全部清空则摘除 subDocs 键。
 */
export function sanitizeRtcCompound(doc: RtcDoc): RtcDoc {
	const hasCompoundSeg = doc.tracks.some((t) => t.segments.some((s) => s.kind === "compound"));
	if (!doc.subDocs && !hasCompoundSeg) return doc;

	let changed = false;

	// ① / ② 子文档表清洗
	const subDocs: Record<string, RtcSubDoc> = {};
	for (const [key, raw] of Object.entries(doc.subDocs ?? {})) {
		if (!raw || typeof raw !== "object" || !Array.isArray((raw as RtcSubDoc).tracks)) {
			changed = true;
			continue;
		}
		const sub = raw as RtcSubDoc;
		let subChanged = false;
		const tracks = sub.tracks.map((t) => {
			if (!t.segments.some((s) => s.kind === "compound")) return t;
			subChanged = true;
			return {
				...t,
				segments: t.segments.map((s) => (s.kind === "compound" ? degradeToPlaceholder(s) : s)),
			};
		});
		if (subChanged) changed = true;
		subDocs[key] = subChanged ? { ...sub, tracks } : sub;
	}

	// ③ 主轨道：compound 引用缺失子文档 → 降级占位符；顺带收集引用
	const referenced = new Set<string>();
	const tracks = doc.tracks.map((t) => {
		let trackChanged = false;
		const segments = t.segments.map((s) => {
			if (s.kind !== "compound") return s;
			if (s.subDocId && subDocs[s.subDocId]) {
				referenced.add(s.subDocId);
				return s;
			}
			trackChanged = true;
			return degradeToPlaceholder(s);
		});
		if (!trackChanged) return t;
		changed = true;
		return { ...t, segments };
	});

	// ④ 孤儿子文档剔除
	for (const key of Object.keys(subDocs)) {
		if (!referenced.has(key)) {
			delete subDocs[key];
			changed = true;
		}
	}

	if (!changed) return doc;
	const next: RtcDoc = { ...doc, tracks };
	if (Object.keys(subDocs).length > 0) next.subDocs = subDocs;
	else delete next.subDocs;
	return next;
}

/** compound → 占位符降级（保留时间/名称，摘除子文档引用；不静默删除用户的时间轴占位） */
function degradeToPlaceholder(s: RtcSegment): RtcSegment {
	const { subDocId: _drop, ...rest } = s;
	void _drop;
	return { ...rest, kind: "placeholder" };
}

/* ────────────────────────── 编辑上下文视图 ────────────────────────── */

/**
 * 「当前编辑层」视图文档：主层 = doc 本身；子层 = 以子文档 tracks 为轨道、fps/画幅**恒随主文档**
 * 的合成视图（不带 subDocs——子层内没有复合片段，rtcOps/播放纯函数拿到它就是一个普通 doc）。
 *
 * ⚠ 引用稳定（WeakMap 缓存）：同一 (doc, subId) 恒返回同一对象——zustand selector 直接用它
 * 不会引发无谓重渲染。子文档缺失（被解散/undo 掉）时回退主文档（调用方按「已退出子层」处理）。
 */
const viewCache = new WeakMap<RtcDoc, Map<string, RtcDoc>>();

export function activeViewDoc(doc: RtcDoc | null, editingSubDocId: string | null): RtcDoc | null {
	if (!doc || !editingSubDocId) return doc;
	const sub = doc.subDocs?.[editingSubDocId];
	if (!sub) return doc; // 子文档已不存在 → 视作回到主层
	let byId = viewCache.get(doc);
	if (!byId) {
		byId = new Map();
		viewCache.set(doc, byId);
	}
	let view = byId.get(editingSubDocId);
	if (!view) {
		view = {
			id: sub.id,
			name: sub.name,
			fps: doc.fps,
			...(doc.canvas ? { canvas: doc.canvas } : {}),
			tracks: sub.tracks,
		};
		byId.set(editingSubDocId, view);
	}
	return view;
}
