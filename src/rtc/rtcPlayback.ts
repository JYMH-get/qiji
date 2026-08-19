/**
 * rtcPlayback.ts —— 实时剪辑预览播放器的纯逻辑（零 DOM/store 依赖，全部可单测）。
 *
 * ⚠ 本轮语义变更（勿当回归改回去）：**从「单主轨顺序预览」升级为「多视频轨图层合成」**。
 * 第235轮的旧语义是「画面 = 第一条 video 轨的活动片段，其余视频轨不参与预览」——用户实测报障：
 * 主轨在某时刻是空隙、下方（数组更靠后 = 图层更靠上）的视频轨明明有片段，预览却黑屏，
 * 「完全违背剪辑软件逻辑，需要图层概念，透过上面的看下面」。故本轮改为：
 *
 *   - 画面 = **全部 video 轨在播放头处的活动片段各自成一层**，按图层高低堆叠，
 *     上层不透明处遮住下层、上层透明处（PNG/带 alpha 的 WebM）透出下层
 *     ——真正的合成由浏览器逐层 alpha 混合完成（见 RtcSequencePlayer 的多层元素）；
 *   - **图层高低口径 = 时间轴显示序**（rtcOps.orderTracksForDisplay：非主视频轨越晚建越靠上、
 *     主轨压在视频组最底）；本模块经 `videoLayerTracksBottomUp` 复用那一处口径，**绝不另写一份**；
 *   - **占位片段（kind:"placeholder"）不构成画面层**：正在生成/待生成的占位直接跳过，让下层旧版本
 *     透出来（第235轮语义：重新生成=在上方轨道新增占位，上下层即版本堆叠——若占位挡住下层，
 *     一按「重新生成」预览就黑屏，正是要避免的）。无地址的 media 片段（uri 缺失）同理跳过；
 *   - 声音 = **全部未静音视频层自身声音**（与剪映一致：画中画被遮住时声音仍在；我们导出是全导，
 *     两边行为对齐）+ 全部未静音 audio 轨在播放头处的可发声片段；
 *   - **画幅（定画幅，对标剪映）**：图层一律在 `docCanvas(doc)` 比例的 letterbox 画幅框内合成
 *     （框外纯黑留白）——画幅是成片边界，不是各层各自贴合容器；框的像素尺寸由 `fitCanvasBox` 解算。
 *     ⚠ 读画幅一律走 types/rtc 的 `docCanvas()`，别自己写 `doc.canvas ?? 1920×1080` 的回退；
 *   - 时间基与 doc 一致（微秒）；源素材时间按 sourceStartUs + 相对偏移 × speed 换算。
 */
import type { RtcCanvas, RtcDoc, RtcSegment, RtcSubDoc, RtcTrack } from "@/types/rtc";
/* 第二批×第四批集成：音量关键帧在**图层/音频条目产出处**统一采样（消费端只用 volume 字段，
 * 子层时间基换算在此天然正确；无 volume 关键帧的片段 = segmentVolume 同值零变化）。 */
import { effectiveVolumeAt } from "@/lib/rtcKeyframes";
import { mainVideoTrackId, orderTracksForDisplay } from "@/lib/rtcOps";
import { findJyTransition, type JyPreviewKind } from "@/lib/jyTransitions";

const US_PER_SEC = 1_000_000;

/* ── 转场真预览（用户定稿：没有预览的转场不上 UI——预览与导出观感必须一致） ──────────
 * 每条视频轨（含复合子层编辑视图里的子轨——那时它们就是顶层轨）静态多一个「转场幽灵槽」
 * （slotId = `${trackId}#tr`）：过渡窗口内承载「另一侧」片段的冻结帧（叠化/推移）或色闪填充
 * （闪黑/闪白），叠在本轨画面层之上。窗口口径：
 *   - 叠化/闪黑/闪白：跨切点对称 [cut−d/2, cut+d/2)；
 *   - 四向推移（push）：切点前 [cut−d, cut)——两画面同步推挤，切点处恰好完成交接。
 * 只有**同轨严格相邻**（A 右缘 == B 左缘）的一对才预览（有空隙=没有可衔接的下一段）。 */

/** 转场幽灵槽的 slotId 后缀 */
export const TRANSITION_SLOT_SUFFIX = "#tr";

/** 转场给图层附加的渲染效果（与片段自身变换/透明度**相乘/叠加**，不替代） */
export interface RtcLayerFx {
	/** 不透明度乘子 0..1 */
	alphaMul?: number;
	/** 过渡位移（占画幅宽/高百分比，叠加在片段变换之外） */
	txPct?: number;
	tyPct?: number;
}

/** 某时刻某轨的转场状态（内部） */
interface TransitionState {
	kind: JyPreviewKind;
	/** 窗口进度 0..1 */
	p: number;
	/** 当前活动侧片段（A=切点前的出场段 / B=切点后的入场段） */
	side: "A" | "B";
	a: RtcSegment;
	b: RtcSegment;
}

/**
 * 该轨此刻是否处于某个可预览转场的窗口内。
 * 遍历带 transitionAfter 且资源可预览的片段 A，找同轨严格相邻的下一段 B，按样式算窗口。
 */
export function transitionStateAt(segments: RtcSegment[], tUs: number): TransitionState | null {
	for (const a of segments) {
		const tr = a.transitionAfter;
		if (!tr) continue;
		const kind = findJyTransition(tr.effectId)?.previewKind;
		if (!kind) continue;
		const cut = a.targetStartUs + a.targetDurationUs;
		const b = segments.find((s) => s !== a && s.targetStartUs === cut);
		if (!b) continue; // 无相邻下一段：转场无从衔接，不预览（导出时剪映同样无效）
		const d = Math.max(1, tr.durationUs);
		const isPush = kind.startsWith("slide");
		const start = isPush ? cut - d : cut - Math.floor(d / 2);
		const end = isPush ? cut : cut + Math.ceil(d / 2);
		// 窗口钳进 A/B 自己的时间跨度（转场时长超过片段时不越界盖到第三段头上）
		if (tUs < Math.max(start, a.targetStartUs) || tUs >= Math.min(end, b.targetStartUs + b.targetDurationUs)) continue;
		return { kind, p: Math.min(1, Math.max(0, (tUs - start) / (end - start))), side: tUs < cut ? "A" : "B", a, b };
	}
	return null;
}

/** 推移方向单位向量（出场段朝该方向移出，入场段从反方向推入） */
function slideDir(kind: JyPreviewKind): { x: number; y: number } {
	switch (kind) {
		case "slideleft": return { x: -1, y: 0 };
		case "slideright": return { x: 1, y: 0 };
		case "slideup": return { x: 0, y: -1 };
		case "slidedown": return { x: 0, y: 1 };
		default: return { x: 0, y: 0 };
	}
}

/** 转场此刻给**本轨活动画面层**附加的效果（推移=出场段随进度移出；其余样式主层不动） */
export function transitionMainFx(ts: TransitionState): RtcLayerFx | null {
	if (ts.kind.startsWith("slide") && ts.side === "A") {
		const dir = slideDir(ts.kind);
		return { txPct: dir.x * ts.p * 100, tyPct: dir.y * ts.p * 100 };
	}
	return null;
}

/** 转场幽灵层的描述（videoStageAt 据此产出 #tr 槽的图层；null=此刻幽灵槽无内容） */
export interface TransitionGhost {
	/** 幽灵承载的片段（叠化=另一侧冻结帧；闪黑/闪白=无片段，纯色填充） */
	seg: RtcSegment | null;
	/** 冻结帧取段首还是段尾 */
	freeze: "start" | "end";
	fx: RtcLayerFx;
	/** 色闪填充色（闪黑/闪白专用；有值时 seg 恒 null） */
	fill?: string;
}

export function transitionGhost(ts: TransitionState): TransitionGhost | null {
	if (ts.kind === "flashblack" || ts.kind === "flashwhite") {
		// 色闪：切点处不透明度到 1（完全遮住切换瞬间），两端归 0——与剪映闪黑/闪白同语义
		return { seg: null, freeze: "start", fx: { alphaMul: 1 - Math.abs(2 * ts.p - 1) }, fill: ts.kind === "flashblack" ? "#000" : "#fff" };
	}
	if (ts.kind === "dissolve") {
		// 叠化：切点前=入场段淡入盖上来（0→0.5），切点后=出场段淡出让下去（0.5→0）——切点处两态都是半透明混合，视觉连续
		return ts.side === "A"
			? { seg: ts.b, freeze: "start", fx: { alphaMul: ts.p } }
			: { seg: ts.a, freeze: "end", fx: { alphaMul: 1 - ts.p } };
	}
	// 推移：入场段冻结帧从反方向推入（切点处恰好到位，B 接管后幽灵消失）
	if (ts.side === "A") {
		const dir = slideDir(ts.kind);
		return { seg: ts.b, freeze: "start", fx: { txPct: -dir.x * (1 - ts.p) * 100, tyPct: -dir.y * (1 - ts.p) * 100 } };
	}
	return null;
}

/* ── 第四批：复合片段（子时间轴）预览递归 ──────────────────────────────────────
 * 复合片段（kind:"compound"）在预览里展开为它的子时间轴图层（嵌套深度 1）：
 *   - 播放头 t → 子时间 subT = sourceStartUs + (t − targetStartUs) × speed（与素材同一换算）；
 *   - 子文档的多条视频轨按其自身上下层序展开，并入 compound 所在图层位置；
 *   - 图层元素的常驻 key 用**槽位 id**：普通轨 = trackId、复合子轨 = `${compoundSegId}/${子trackId}`
 *     ——槽位从 doc 结构静态枚举（videoLayerSlotsBottomUp），播放头扫过复合边界时元素只显隐不重建
 *     （RtcSequencePlayer「图层元素按 key 常驻复用」铁律的延续）。 */

/** 图层槽位：预览播放器按它渲染常驻元素（slotId = RtcVideoLayer.trackId 的取值域） */
export interface RtcLayerSlot {
	/** 槽位 id：普通视频轨 = 轨道 id；复合子轨 = `${compoundSegId}/${子trackId}` */
	slotId: string;
	/** 宿主轨 id（普通槽=自身；复合子槽=复合片段所在主轨） */
	hostTrackId: string;
}

/** 复合片段在播放头 t 处的子时间（微秒；t 须已在片段区间内）——与 sourceTimeSec 同一换算口径 */
export function compoundSubTimeUs(seg: RtcSegment, tUs: number): number {
	const speed = segmentRate(seg);
	const s0 = seg.sourceStartUs ?? 0;
	let subUs = s0 + Math.max(0, tUs - seg.targetStartUs) * speed;
	if (seg.sourceDurationUs != null) subUs = Math.min(subUs, s0 + seg.sourceDurationUs);
	return subUs;
}

function subDocOf(doc: RtcDoc, seg: RtcSegment): RtcSubDoc | null {
	return (seg.kind === "compound" && seg.subDocId && doc.subDocs?.[seg.subDocId]) || null;
}

/** 子文档的视频轨自下而上（子层内部沿用同一套显示序口径） */
function subVideoTracksBottomUp(sub: RtcSubDoc): RtcTrack[] {
	return orderTracksForDisplay(sub.tracks)
		.filter((t) => t.type === "video")
		.reverse();
}

/**
 * 全部图层槽位自下而上：每条 video 轨一个槽位；轨上每个复合片段（按时间序）再为其子文档的
 * 每条视频子轨追加一个槽位（紧随宿主槽之上——同一宿主轨上「普通片段」与「复合片段」在时间上
 * 互斥，槽位共存但同一时刻至多一方有画面）。
 */
export function videoLayerSlotsBottomUp(doc: RtcDoc): RtcLayerSlot[] {
	const out: RtcLayerSlot[] = [];
	for (const track of videoLayerTracksBottomUp(doc)) {
		out.push({ slotId: track.id, hostTrackId: track.id });
		// 转场幽灵槽：紧贴本轨画面层之上（过渡窗口外恒隐藏；元素常驻复用同一铁律）
		out.push({ slotId: `${track.id}${TRANSITION_SLOT_SUFFIX}`, hostTrackId: track.id });
		for (const seg of track.segments) {
			const sub = subDocOf(doc, seg);
			if (!sub) continue;
			for (const st of subVideoTracksBottomUp(sub)) {
				out.push({ slotId: `${seg.id}/${st.id}`, hostTrackId: track.id });
			}
		}
	}
	return out;
}

/**
 * 一层画面：某条 video 轨在播放头处的活动片段（已解算好渲染/发声所需的全部数值）。
 * 只有可渲染的 media 片段才成层——placeholder 与无 uri 的片段不产生 layer。
 */
export interface RtcVideoLayer {
	/** 图层槽位 id——多层元素按它作 key 常驻复用（换段只换 src，绝不重建元素）。
	 *  普通视频轨 = 轨道 id；复合片段子轨 = `${compoundSegId}/${子trackId}`（第四批，见 RtcLayerSlot） */
	trackId: string;
	/** 图层高度：0=最底（主轨），数值越大越靠上（可直接作 z-index 基准） */
	layerIndex: number;
	/** 该层这一刻的呈现介质 */
	media: "image" | "video";
	seg: RtcSegment;
	/** 显示地址（成层的前提，恒非空；**纯色填充幽灵层除外**——uri 为空、fill 有值） */
	uri: string;
	/** 该层本地播放时刻（秒）——已按 sourceStartUs + Δt×speed 换算并钳位 */
	sourceSec: number;
	/** 关键帧采样的相对时刻（µs，相对该片段 target 起点）——⚠ 顶层=主时间基、复合子层=**子时间基**，
	 *  在产出处算好；渲染/选中框/画面点选一律消费此字段，勿在消费端用 frameUs−targetStartUs 自算
	 *  （子层会拿主时间减子起点=时间基错配）。 */
	kfRelUs: number;
	/** 该层是否静音（片段静音 || 轨道静音；image 层无意义恒 true） */
	muted: boolean;
	/** 片段音量 0..1（muted 由上面的字段表达，不合并进来） */
	volume: number;
	/** 播放速率（媒体元素安全区间内） */
	rate: number;
	/** 转场附加效果（透明度乘子/过渡位移；与片段自身变换相乘/叠加） */
	fx?: RtcLayerFx;
	/** 转场幽灵层（#tr 槽）：不参与画面点选/选中框，不发声 */
	ghost?: boolean;
	/** 冻结帧：入段对时后**永不 play**（转场幽灵的段首/段尾定格） */
	frozen?: boolean;
	/** 纯色填充层（闪黑/闪白）：uri 为空、只画背景色 */
	fill?: string;
}

/**
 * 允许解码播放的视频层 trackId 集合（性能护栏）：**从最上层往下取**——上层本就遮住下层，
 * 保住看得见的那几层；超出上限的下层被调用方 pause（停在静止帧且不发声，属已知取舍）。
 * limit ≤ 0 视为不限制（全放行）。
 *
 * 多层 `<video>` 同时解码很吃 GPU/内存（WebView2 下尤其明显），上限档由预览设置给出
 * （rtcPreviewStore.maxDecodeLayers，默认 4 层——够覆盖「主轨 + 两三层画中画/版本堆叠」）。
 */
export function activeDecodeTrackIds(layers: RtcVideoLayer[], limit: number): Set<string> {
	const out = new Set<string>();
	if (!(limit > 0)) {
		for (const l of layers) if (l.media === "video" && !l.frozen) out.add(l.trackId);
		return out;
	}
	for (let i = layers.length - 1; i >= 0 && out.size < limit; i--) {
		// 冻结幽灵层（转场定格帧）不占解码位——它永不 play，不该把下层真画面挤出解码上限
		if (layers[i].media === "video" && !layers[i].frozen) out.add(layers[i].trackId);
	}
	return out;
}

/** 播放头处的画面图层清单 */
export interface RtcVideoStage {
	/** **自下而上**排序（下标 0 = 最底层；下标越大越靠上、越后绘制） */
	layers: RtcVideoLayer[];
	/**
	 * 无任何画面层时，播放头处命中的最上层占位片段——**只作提示卡，不是画面层**
	 * （有下层画面时恒为 null：占位绝不遮挡下层实拍/旧版本）。
	 */
	placeholder: RtcSegment | null;
}

/**
 * 主视频轨 = 第一条 type:"video" 轨；无则 null。
 * ⚠ 口径单点：转调 rtcOps.mainVideoTrackId（时间轴/导出/预览共用同一定义，勿另算）。
 */
export function mainVideoTrack(doc: RtcDoc): RtcTrack | null {
	const id = mainVideoTrackId(doc.tracks);
	return id ? (doc.tracks.find((t) => t.id === id) ?? null) : null;
}

/**
 * 全部 video 轨按**图层自下而上**排列（下标 0 = 最底 = 主轨）。
 * ⚠ 口径单点：从 rtcOps.orderTracksForDisplay（时间轴显示序，从上到下）取视频段再倒序
 * ——显示上越靠上的轨道 = 图层越靠上，两处规则永不漂移。
 */
export function videoLayerTracksBottomUp(doc: RtcDoc): RtcTrack[] {
	return orderTracksForDisplay(doc.tracks)
		.filter((t) => t.type === "video")
		.reverse();
}

/** 画幅框在预览容器里的像素位置（居中 letterbox） */
export interface RtcCanvasBox {
	left: number;
	top: number;
	width: number;
	height: number;
}

/**
 * 画幅框解算：把 canvas 的宽高比按 contain 放进 boxW×boxH 的预览容器并居中，框外即黑边留白。
 * 容器尚未测量（0 宽/高）时返回全 0——调用方回退成铺满，避免首帧闪空。
 */
export function fitCanvasBox(boxW: number, boxH: number, canvas: RtcCanvas): RtcCanvasBox {
	if (!(boxW > 0) || !(boxH > 0) || !(canvas.width > 0) || !(canvas.height > 0)) {
		return { left: 0, top: 0, width: 0, height: 0 };
	}
	const ratio = canvas.width / canvas.height;
	let width = boxW;
	let height = boxW / ratio;
	if (height > boxH) {
		height = boxH;
		width = boxH * ratio;
	}
	return { left: (boxW - width) / 2, top: (boxH - height) / 2, width, height };
}

/** doc 是否有任何片段（播放器显隐判据） */
export function docHasAnySegment(doc: RtcDoc): boolean {
	return doc.tracks.some((t) => t.segments.length > 0);
}

/**
 * 播放头处的活动片段：targetStartUs ≤ t < targetStartUs + targetDurationUs。
 * 右缘开区间——相邻片段的交界时刻归**后一段**（start 命中优先于 end）。
 */
export function segmentAt(segments: RtcSegment[], tUs: number): RtcSegment | null {
	for (const s of segments) {
		if (tUs >= s.targetStartUs && tUs < s.targetStartUs + s.targetDurationUs) return s;
	}
	return null;
}

/**
 * 播放头处的画面图层清单（自下而上）。
 *
 * 逐条 video 轨取活动片段：
 *   - placeholder（未生成/生成中/失败）→ **跳过**，让下层透出（另记进 stage.placeholder 作提示卡）；
 *   - media 但无 uri（素材地址缺失）→ 跳过（无从渲染，同样不该挡住下层）；
 *   - media 且 media∈{image,video} → 成一层；轨道上的音频等异常形态一律跳过。
 */
export function videoStageAt(doc: RtcDoc, tUs: number): RtcVideoStage {
	const layers: RtcVideoLayer[] = [];
	let placeholder: RtcSegment | null = null;
	/** 槽位序号（与 videoLayerSlotsBottomUp 同一枚举序）——layerIndex/z 基准 */
	let slotIndex = 0;
	for (const track of videoLayerTracksBottomUp(doc)) {
		// 转场真预览：本轨此刻是否在某个可预览转场的窗口内（主层附加 fx + #tr 幽灵槽出内容）
		const ts = transitionStateAt(track.segments, tUs);
		const seg = segmentAt(track.segments, tUs);
		const activeCompound = seg && seg.kind === "compound" ? seg : null;
		if (seg && !activeCompound) {
			if (seg.kind === "placeholder") {
				placeholder = seg; // 自下而上遍历 → 留下的是最上层的占位（最新一次「重新生成」）
			} else if (seg.uri && (seg.media === "image" || seg.media === "video")) {
				// 主层转场效果只作用于转场两侧的活动片段自身（窗口越界盖到第三段时不误伤）
				const activeSide = ts && ((ts.side === "A" && seg === ts.a) || (ts.side === "B" && seg === ts.b)) ? ts : null;
				const mainFx = activeSide ? transitionMainFx(activeSide) : null;
				layers.push({
					trackId: track.id,
					layerIndex: slotIndex,
					media: seg.media,
					seg,
					uri: seg.uri,
					sourceSec: sourceTimeSec(seg, tUs),
					kfRelUs: tUs - seg.targetStartUs,
					muted: seg.media !== "video" || !!seg.muted || !!track.muted,
					volume: effectiveVolumeAt(seg, tUs - seg.targetStartUs),
					rate: segmentRate(seg),
					...(mainFx ? { fx: mainFx } : {}),
				});
			}
		}
		slotIndex++;
		// 转场幽灵槽（#tr，恒占一个槽位——与 videoLayerSlotsBottomUp 严格同序）
		if (ts) {
			const g = transitionGhost(ts);
			if (g) {
				if (g.fill) {
					// 色闪填充层：无片段无 uri，只画背景色（ghost 不参与点选/发声）
					layers.push({
						trackId: `${track.id}${TRANSITION_SLOT_SUFFIX}`,
						layerIndex: slotIndex,
						media: "image",
						seg: ts.a,
						uri: "",
						sourceSec: 0,
						kfRelUs: 0,
						muted: true,
						volume: 0,
						rate: 1,
						fx: g.fx,
						ghost: true,
						fill: g.fill,
					});
				} else if (g.seg && g.seg.kind === "media" && g.seg.uri && (g.seg.media === "image" || g.seg.media === "video")) {
					// 另一侧片段的冻结帧（段首/段尾定格；复合/占位做不了定格 → 跳过，转场退化为主层效果）
					const freezeEnd = g.freeze === "end";
					layers.push({
						trackId: `${track.id}${TRANSITION_SLOT_SUFFIX}`,
						layerIndex: slotIndex,
						media: g.seg.media,
						seg: g.seg,
						uri: g.seg.uri,
						sourceSec: freezeEnd
							? sourceTimeSec(g.seg, g.seg.targetStartUs + g.seg.targetDurationUs)
							: (g.seg.sourceStartUs ?? 0) / US_PER_SEC,
						kfRelUs: freezeEnd ? g.seg.targetDurationUs : 0,
						muted: true,
						volume: 0,
						rate: 1,
						fx: g.fx,
						ghost: true,
						frozen: g.seg.media === "video",
					});
				}
			}
		}
		slotIndex++;
		// 第四批：复合片段展开——轨上每个复合片段的子视频轨各占一个槽位（静态枚举，与
		// videoLayerSlotsBottomUp 严格同序）；只有播放头落在该复合区间内时其子槽才可能出画。
		for (const c of track.segments) {
			const sub = subDocOf(doc, c);
			if (!sub) continue;
			const cActive = activeCompound === c;
			const subT = cActive ? compoundSubTimeUs(c, tUs) : 0;
			const cRate = segmentRate(c);
			const cVolume = segmentVolume(c);
			const hostMuted = !!c.muted || !!track.muted;
			for (const st of subVideoTracksBottomUp(sub)) {
				if (cActive) {
					const ss = segmentAt(st.segments, subT);
					// 子层内不再嵌复合（sanitize 保证）；占位符/无 uri 一律跳过（不遮下层）
					if (ss && ss.kind === "media" && ss.uri && (ss.media === "image" || ss.media === "video")) {
						layers.push({
							trackId: `${c.id}/${st.id}`,
							layerIndex: slotIndex,
							media: ss.media,
							seg: ss,
							uri: ss.uri,
							sourceSec: sourceTimeSec(ss, subT),
							kfRelUs: subT - ss.targetStartUs,
							muted: ss.media !== "video" || !!ss.muted || !!st.muted || hostMuted,
							volume: clamp01(effectiveVolumeAt(ss, subT - ss.targetStartUs) * cVolume),
							rate: clampRate(segmentRate(ss) * cRate),
						});
					}
				}
				slotIndex++;
			}
		}
	}
	// 有画面就不显示占位提示卡（占位绝不遮挡下层）
	return { layers, placeholder: layers.length > 0 ? null : placeholder };
}

function clamp01(v: number): number {
	return Math.min(1, Math.max(0, v));
}

function clampRate(v: number): number {
	return Math.min(16, Math.max(0.1, v));
}

/** 该片段是否构成画面层（与 videoStageAt 同一口径：真实素材 + 有 uri + 图/视）——占位绝不遮挡下层。
 *  第四批：compound 按「整段有画面」近似处理（子时间轴逐时刻有无内容不在遮挡判定里展开，
 *  这是时间轴弱化提示的显示近似，不影响播放合成）。 */
function isPictureSegment(seg: RtcSegment): boolean {
	if (seg.kind === "compound") return true;
	return seg.kind !== "placeholder" && !!seg.uri && (seg.media === "image" || seg.media === "video");
}

/**
 * 被上层完全遮挡的片段 id 集合（时间轴用来做「保留但不生效」的视觉弱化）。
 *
 * 判定与 videoStageAt 同口径：只有**构成画面层**的片段才会遮挡别人（占位/无 uri/非图视一律透下去），
 * 且必须在被遮片段的**整个时间跨度**上都有上层画面覆盖，才算完全遮挡——露出一丝都不算。
 * 只有视频轨参与（音频不存在遮挡关系）。
 *
 * 算法：自上而下逐轨推进，维护「上方各层画面区间的并集」；对每条轨道先判定其片段是否被并集完全包含，
 * 再把本轨的画面区间并进去传给下一轨。区间按起点有序（rtcOps 维持的不变量），合并是线性的。
 */
export function coveredSegmentIds(doc: RtcDoc): string[] {
	const topDown = videoLayerTracksBottomUp(doc).slice().reverse();
	const out: string[] = [];
	/** 上方所有画面层的区间并集，按起点升序且互不相交 */
	let above: Array<[number, number]> = [];
	for (const track of topDown) {
		for (const seg of track.segments) {
			const s = seg.targetStartUs;
			const e = s + seg.targetDurationUs;
			if (e <= s) continue;
			if (intervalsCover(above, s, e)) out.push(seg.id);
		}
		const own: Array<[number, number]> = [];
		for (const seg of track.segments) {
			if (!isPictureSegment(seg)) continue;
			const s = seg.targetStartUs;
			const e = s + seg.targetDurationUs;
			if (e > s) own.push([s, e]);
		}
		if (own.length) above = mergeIntervals(above.concat(own));
	}
	return out;
}

/** [s,e) 是否被有序不相交区间集完全覆盖（允许由多段相接的区间拼起来覆盖） */
function intervalsCover(sorted: Array<[number, number]>, s: number, e: number): boolean {
	let cur = s;
	for (const [a, b] of sorted) {
		if (b <= cur) continue;
		if (a > cur) return false; // 出现缺口
		cur = b;
		if (cur >= e) return true;
	}
	return cur >= e;
}

/** 合并区间为有序不相交集合（相接的 [a,b)[b,c) 也并成一段——中间没有露出画面） */
function mergeIntervals(list: Array<[number, number]>): Array<[number, number]> {
	if (list.length <= 1) return list;
	const sorted = list.slice().sort((x, y) => x[0] - y[0]);
	const out: Array<[number, number]> = [sorted[0]];
	for (let i = 1; i < sorted.length; i++) {
		const last = out[out.length - 1];
		const [a, b] = sorted[i];
		if (a <= last[1]) last[1] = Math.max(last[1], b);
		else out.push([a, b]);
	}
	return out;
}

/**
 * 播放头 → 源素材时间（秒）：sourceStartUs + (t - targetStartUs) × speed。
 * 相对偏移钳非负；有源窗口时钳到窗口右缘（片段末尾浮点误差不越界）。
 * ⚠ 右缘钳制兼作**存量失配 doc 的播放防御**：变速曾只 patch speed 不联动时长（老 bug），
 * 存量项目里有 targetDur×speed > sourceDur 的片段——源耗尽后这里恒返回窗口末尾，
 * 播放器漂移校正把 video.currentTime 拉回来=定住尾帧，绝不放飞出错画面。勿删此钳。
 */
export function sourceTimeSec(seg: RtcSegment, tUs: number): number {
	const speed = segmentRate(seg);
	const s0 = seg.sourceStartUs ?? 0;
	let srcUs = s0 + Math.max(0, tUs - seg.targetStartUs) * speed;
	if (seg.sourceDurationUs != null) srcUs = Math.min(srcUs, s0 + seg.sourceDurationUs);
	return srcUs / US_PER_SEC;
}

/**
 * 播放头处应发声的音频片段：全部**未静音** audio 轨上、kind=media、有 uri、
 * 自身未静音、且播放头落在其区间内的片段。轨道静音（track.muted）整轨跳过；
 * 片段静音（seg.muted）= 无声，直接不进池。
 */
export function collectAudibleSegments(doc: RtcDoc, tUs: number): RtcSegment[] {
	const out: RtcSegment[] = [];
	for (const track of doc.tracks) {
		if (track.type !== "audio" || track.muted) continue;
		for (const s of track.segments) {
			if (s.kind !== "media" || !s.uri || s.muted) continue;
			if (tUs >= s.targetStartUs && tUs < s.targetStartUs + s.targetDurationUs) out.push(s);
		}
	}
	return out;
}

/* ── 第四批：复合片段的音频递归 ── */

/** 一条已解算完毕的可发声条目（播放器音频池直接消费，无需再做时间/音量换算） */
export interface RtcAudibleClip {
	/** 池 key：主层音频片段 = seg.id；复合子层音频 = `${compoundSegId}/${子segId}` */
	id: string;
	uri: string;
	/** 该条目此刻的源时间（秒，已含复合偏移与 speed 换算） */
	sourceSec: number;
	/** 音量（子层 = 子片段音量 × 复合片段音量） */
	volume: number;
	/** 播放速率（子层 = 子片段速率 × 复合片段速率，夹到媒体元素安全区间） */
	rate: number;
}

/**
 * 播放头处应发声的全部音频条目（collectAudibleSegments 的复合感知升级版，播放器走这里）：
 *   ① 主层音频轨片段（口径与 collectAudibleSegments 完全一致）；
 *   ② **任意类型轨道**上处于活动区间的复合片段 → 递归其子文档的音频轨（深度 1）；
 *      宿主静音（复合片段 muted / 宿主轨 muted）整组跳过；子层轨道/片段静音同主层规则。
 */
export function collectAudibleAt(doc: RtcDoc, tUs: number): RtcAudibleClip[] {
	const out: RtcAudibleClip[] = [];
	for (const s of collectAudibleSegments(doc, tUs)) {
		out.push({
			id: s.id,
			uri: s.uri as string,
			sourceSec: sourceTimeSec(s, tUs),
			volume: effectiveVolumeAt(s, tUs - s.targetStartUs),
			rate: segmentRate(s),
		});
	}
	for (const track of doc.tracks) {
		if (track.muted) continue;
		for (const c of track.segments) {
			if (c.kind !== "compound" || c.muted) continue;
			if (!(tUs >= c.targetStartUs && tUs < c.targetStartUs + c.targetDurationUs)) continue;
			const sub = subDocOf(doc, c);
			if (!sub) continue;
			const subT = compoundSubTimeUs(c, tUs);
			const cVolume = segmentVolume(c);
			const cRate = segmentRate(c);
			for (const st of sub.tracks) {
				if (st.type !== "audio" || st.muted) continue;
				for (const s of st.segments) {
					if (s.kind !== "media" || !s.uri || s.muted) continue;
					if (!(subT >= s.targetStartUs && subT < s.targetStartUs + s.targetDurationUs)) continue;
					out.push({
						id: `${c.id}/${s.id}`,
						uri: s.uri,
						sourceSec: sourceTimeSec(s, subT),
						volume: clamp01(effectiveVolumeAt(s, subT - s.targetStartUs) * cVolume),
						rate: clampRate(segmentRate(s) * cRate),
					});
				}
			}
		}
	}
	return out;
}

/**
 * 音频池可能用到的全部条目 id（主层片段 id + 复合子层复合 id）——播放器按它清理已失效的池元素，
 * 勿只按主层片段 id 清（会把复合子层的池条目每次 doc 变更都误删重建）。
 */
export function audiblePoolIds(doc: RtcDoc): Set<string> {
	const alive = new Set<string>();
	for (const t of doc.tracks) {
		for (const s of t.segments) {
			alive.add(s.id);
			const sub = subDocOf(doc, s);
			if (!sub) continue;
			for (const st of sub.tracks) for (const ss of st.segments) alive.add(`${s.id}/${ss.id}`);
		}
	}
	return alive;
}

/** 片段音量（0..1 夹取；缺省 1）——muted 另由元素 muted 属性表达，这里不合并 */
export function segmentVolume(seg: RtcSegment): number {
	const v = seg.volume;
	if (v == null || !Number.isFinite(v)) return 1;
	return Math.min(1, Math.max(0, v));
}

/** 片段播放速率（缺省/非法回退 1；夹到媒体元素安全区间 [0.1, 16]） */
export function segmentRate(seg: RtcSegment): number {
	const v = seg.speed;
	if (v == null || !Number.isFinite(v) || v <= 0) return 1;
	return Math.min(16, Math.max(0.1, v));
}
