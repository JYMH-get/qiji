/**
 * rtcTransform.ts —— 预览区「片段画面变换」的纯逻辑层（零 DOM / 零 store 依赖，全部可单测）。
 *
 * 服务于两件事：
 *   ① **渲染**：把 `RtcTransform` 组装成 CSS transform 串，叠加在图层元素既有的
 *      `object-fit: contain` 铺满之上（contain 是基准，变换是相对基准的偏移/缩放/旋转）；
 *   ② **交互**：预览区内直接拖动素材（移动 / 缩放 / 旋转）的坐标换算与解算。
 *
 * ── 坐标系约定（贯穿全模块，勿混）────────────────────────────────────────────
 *   - **画幅坐标**：以画幅框（letterbox 内框）左上角为原点的像素坐标，x 向右、y 向下；
 *     交互层把 clientX/Y 减去画幅框的 client 矩形即得（见 `screenToFrame`）。
 *   - **数据里的位置是比例**（RtcTransform.x/y = 画幅宽/高的比例，0=画幅中心）——切画幅/换
 *     分辨率档时素材不失位（见 types/rtc 注释）。两者换算恒经本模块，别在组件里手写除法。
 *   - **角度**：度、顺时针为正。画幅坐标是 y 向下的左手系，所以数学式
 *     `x' = x·cos − y·sin, y' = x·sin + y·cos` 在屏幕上正好表现为顺时针，与 CSS `rotate()` 一致。
 *
 * ── 基准尺寸（base）────────────────────────────────────────────────────────
 * 变换的「1 倍」= 素材在画幅内 contain 居中铺满后的显示矩形（`containSize`），**不是**画幅本身：
 * 竖版素材放进横画幅时，scale=1 指的是它 contain 后的那个窄条。素材自然尺寸未知（元数据未加载）
 * 时回退成画幅整框——此时选中框可能比实际画面大，等元数据到了自动收紧。
 *
 * ⚠ CSS 位移刻意用**百分比**而非像素：`translate(x%,…)` 的百分比基准是元素自身边框盒，而图层
 * 元素恒 `inset:0` 铺满画幅框 → 百分比 ≡ 画幅比例，**渲染完全不依赖 JS 实测**（画幅框排版本身
 * 就是纯 CSS 容器查询算的，勿把测量塞回渲染链路）。实测矩形只喂给交互解算与选中框几何。
 */
import { DEFAULT_RTC_TRANSFORM, segTransform, type RtcDoc, type RtcTransform } from "@/types/rtc";
// ⚠ 缩放限值与「落库/删字段」策略的唯一来源是核心层——本文件（交互层）绝不另立一份，
//    否则会出现「预览里拖到 15×、去属性面板碰一下被压回 10×」这类两把尺子的故障。
import { SCALE_MAX, SCALE_MIN, storeTransform } from "@/lib/rtcTransformCore";

/** 缩放下限/上限：防拖成 0（不可再拖回来）或拖到天量把合成器拖垮 */
/** 缩放下/上限：转发核心层常量（本文件不自定义，见文件顶部说明） */
export const MIN_LAYER_SCALE = SCALE_MIN;
export const MAX_LAYER_SCALE = SCALE_MAX;

/** 旋转吸附步长（按住 Shift 生效，对标剪映/设计软件惯例） */
export const ROTATE_SNAP_DEG = 15;

export interface RtcSize {
	w: number;
	h: number;
}

export interface RtcPoint {
	x: number;
	y: number;
}

/** 八个缩放手柄：四角（等比默认）+ 四边（单向） */
export type RtcHandleId = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

/** 手柄绘制顺序（四角在前，便于命中优先级/样式区分） */
export const RTC_HANDLES: readonly RtcHandleId[] = ["nw", "ne", "se", "sw", "n", "e", "s", "w"] as const;

/** 手柄在「未旋转局部坐标」里的方向：-1/0/1，(0,0) 不存在 */
export function handleDir(handle: RtcHandleId): { hx: number; hy: number } {
	const hx = handle.includes("w") ? -1 : handle.includes("e") ? 1 : 0;
	const hy = handle.includes("n") ? -1 : handle.includes("s") ? 1 : 0;
	return { hx, hy };
}

/** 是否角手柄（两轴都动 → 默认等比） */
export function isCornerHandle(handle: RtcHandleId): boolean {
	const { hx, hy } = handleDir(handle);
	return hx !== 0 && hy !== 0;
}

/* ══════════════════ ① 渲染：变换 → CSS ══════════════════ */

function nearly(a: number, b: number, eps = 1e-6): boolean {
	return Math.abs(a - b) < eps;
}

/** 是否恒等变换（= 缺省的 contain 居中铺满）——恒等时渲染层**整个省略 transform 属性**，与改造前逐字节一致 */
export function isIdentityTransform(t: RtcTransform): boolean {
	return (
		nearly(t.scaleX, 1) &&
		nearly(t.scaleY, 1) &&
		nearly(t.x, 0) &&
		nearly(t.y, 0) &&
		nearly(t.rotation, 0) &&
		nearly(t.opacity, 1) &&
		!t.flipH &&
		!t.flipV
	);
}

/** 两个变换是否等价（commit 前的 no-op 判据） */
export function sameTransform(a: RtcTransform, b: RtcTransform): boolean {
	return (
		nearly(a.scaleX, b.scaleX) &&
		nearly(a.scaleY, b.scaleY) &&
		nearly(a.x, b.x) &&
		nearly(a.y, b.y) &&
		nearly(a.rotation, b.rotation) &&
		nearly(a.opacity, b.opacity) &&
		!!a.flipH === !!b.flipH &&
		!!a.flipV === !!b.flipV
	);
}

function round(v: number, digits = 4): number {
	const p = 10 ** digits;
	return Math.round(v * p) / p;
}

/**
 * 变换 → CSS `transform` 值（配 `transform-origin: center`）。
 *
 * 顺序 `translate → rotate → scale`：CSS 从右往左作用，即**先缩放、再旋转、最后位移**
 * ——与剪映/设计软件语义一致（旋转绕素材自身中心，位移在画幅坐标里）。
 * 位移用百分比（基准=图层元素自身边框盒=画幅框，见文件头）。
 * 恒等变换返回 null → 调用方**不写 transform 属性**（零回归）。
 */
export function transformCss(t: RtcTransform): string | null {
	if (isIdentityTransform(t)) return null;
	const sx = round(t.scaleX * (t.flipH ? -1 : 1));
	const sy = round(t.scaleY * (t.flipV ? -1 : 1));
	return `translate(${round(t.x * 100, 3)}%, ${round(t.y * 100, 3)}%) rotate(${round(t.rotation, 3)}deg) scale(${sx}, ${sy})`;
}

/* ══════════════════ ② 几何 ══════════════════ */

/** 屏幕坐标 → 画幅坐标（rect = 画幅框的 client 矩形） */
export function screenToFrame(clientX: number, clientY: number, rect: { left: number; top: number }): RtcPoint {
	return { x: clientX - rect.left, y: clientY - rect.top };
}

/**
 * 素材在画幅内 contain 居中后的显示尺寸（= 变换的 1 倍基准）。
 * 自然尺寸未知/非法 → 回退画幅整框（元数据到位后自动收紧）。
 */
export function containSize(frame: RtcSize, natural?: RtcSize | null): RtcSize {
	if (!(frame.w > 0) || !(frame.h > 0)) return { w: 0, h: 0 };
	if (!natural || !(natural.w > 0) || !(natural.h > 0)) return { w: frame.w, h: frame.h };
	const s = Math.min(frame.w / natural.w, frame.h / natural.h);
	return { w: natural.w * s, h: natural.h * s };
}

/**
 * contain 基准占画幅的**比例**（0..1）——选中框渲染专用的零测量版 containSize。
 *
 * ⚠ 选中框几何必须与图层的 CSS 排版逐像素一致，而图层排版是纯 CSS（容器查询定画幅框 +
 * object-fit: contain），**不经任何 JS 实测**。选中框若用 ResizeObserver 实测的像素矩形来画，
 * WebView2 下测量滞后/取整会让框比真实画面大或偏（实机报障：右/下边缘与画面不贴合）。
 * 故渲染只用比例：只依赖 画幅宽高比（doc.canvas，纯数据）与素材自然宽高比——两者都零测量。
 * 实测矩形只允许喂给**拖动解算**（且要在手势开始时现读 getBoundingClientRect，勿用缓存态）。
 */
export function containFrac(frameRatio: number, natural?: RtcSize | null): RtcSize {
	if (!(frameRatio > 0)) return { w: 0, h: 0 };
	if (!natural || !(natural.w > 0) || !(natural.h > 0)) return { w: 1, h: 1 };
	const rn = natural.w / natural.h;
	// 素材更宽 → 宽铺满、高按比例缩；更高 → 反之（与 containSize 完全同构，只是化成画幅比例）
	return rn >= frameRatio ? { w: 1, h: frameRatio / rn } : { w: rn / frameRatio, h: 1 };
}

/** 画幅中心（画幅坐标） */
export function frameCenter(frame: RtcSize): RtcPoint {
	return { x: frame.w / 2, y: frame.h / 2 };
}

/** 绕原点旋转一个向量（度，顺时针；画幅坐标 y 向下） */
export function rotateVec(v: RtcPoint, deg: number): RtcPoint {
	const r = (deg * Math.PI) / 180;
	const c = Math.cos(r);
	const s = Math.sin(r);
	return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}

/** 绕某点旋转一个点 */
export function rotatePoint(p: RtcPoint, center: RtcPoint, deg: number): RtcPoint {
	const v = rotateVec({ x: p.x - center.x, y: p.y - center.y }, deg);
	return { x: center.x + v.x, y: center.y + v.y };
}

/** 选中框几何（画幅坐标）：中心、缩放后宽高（未旋转）、旋转角、旋转后的四角 */
export interface RtcBoxGeom {
	center: RtcPoint;
	/** 缩放后的宽高（未旋转；镜像不影响尺寸） */
	w: number;
	h: number;
	rotation: number;
	/** 旋转后的四角，顺序 nw, ne, se, sw */
	corners: RtcPoint[];
}

/** 由「画幅框 + 基准尺寸 + 变换」解出选中框几何 */
export function segBoxGeom(frame: RtcSize, base: RtcSize, t: RtcTransform): RtcBoxGeom {
	const w = Math.abs(base.w * t.scaleX);
	const h = Math.abs(base.h * t.scaleY);
	const c = frameCenter(frame);
	const center = { x: c.x + t.x * frame.w, y: c.y + t.y * frame.h };
	const hw = w / 2;
	const hh = h / 2;
	const corners = (
		[
			{ x: -hw, y: -hh },
			{ x: hw, y: -hh },
			{ x: hw, y: hh },
			{ x: -hw, y: hh },
		] as RtcPoint[]
	).map((v) => {
		const r = rotateVec(v, t.rotation);
		return { x: center.x + r.x, y: center.y + r.y };
	});
	return { center, w, h, rotation: t.rotation, corners };
}

/** 中心点（画幅坐标）反推位置比例 */
function centerToRatio(center: RtcPoint, frame: RtcSize): { x: number; y: number } {
	const c = frameCenter(frame);
	return { x: (center.x - c.x) / frame.w, y: (center.y - c.y) / frame.h };
}

/* ══════════════════ ③ 手势解算 ══════════════════ */

/** 移动：屏幕像素位移 → 位置比例增量（画幅框未测到时原样返回，绝不产生 NaN 写进数据） */
export function applyMove(t0: RtcTransform, deltaPx: RtcPoint, frame: RtcSize): RtcTransform {
	if (!(frame.w > 0) || !(frame.h > 0)) return t0;
	return { ...t0, x: t0.x + deltaPx.x / frame.w, y: t0.y + deltaPx.y / frame.h };
}

export interface ScaleDragInput {
	/** 按下那一刻的变换（整个拖动过程都以它为基准，避免逐帧累积漂移） */
	t0: RtcTransform;
	frame: RtcSize;
	/** contain 基准尺寸 */
	base: RtcSize;
	/** 当前指针（画幅坐标） */
	pointer: RtcPoint;
	handle: RtcHandleId;
	/** 等比：仅对角手柄有意义（边手柄恒单轴） */
	uniform: boolean;
}

/**
 * 缩放解算（**对角/对边锚点固定**）：
 *   1. 求锚点 A = 手柄的对角（角手柄）或对边中点（边手柄）的世界位置；
 *   2. 把指针换算进「未旋转局部坐标」，得到从锚点出发的新半径 → 新宽高；
 *   3. 等比时把指针位移**投影到原对角线**（最小二乘投影，比「取较大轴」平滑无抖动）；
 *   4. 反解新中心：锚点必须纹丝不动 → center' = A + R(θ)·(h·新半宽, 新半高)。
 *
 * ⚠ 只动 scaleX/scaleY/x/y 四个字段——旋转、不透明度、镜像原样带走。
 */
export function applyScale(input: ScaleDragInput): RtcTransform {
	const { t0, frame, base, pointer, handle, uniform } = input;
	if (!(frame.w > 0) || !(frame.h > 0) || !(base.w > 0) || !(base.h > 0)) return t0;
	const { hx, hy } = handleDir(handle);
	const g = segBoxGeom(frame, base, t0);
	if (!(g.w > 0) || !(g.h > 0)) return t0;

	// 锚点（世界）：手柄的正对面
	const anchorLocal = { x: (-hx * g.w) / 2, y: (-hy * g.h) / 2 };
	const ar = rotateVec(anchorLocal, t0.rotation);
	const anchor = { x: g.center.x + ar.x, y: g.center.y + ar.y };

	// 指针相对锚点，换回未旋转局部坐标
	const L = rotateVec({ x: pointer.x - anchor.x, y: pointer.y - anchor.y }, -t0.rotation);

	let fx = 1;
	let fy = 1;
	const corner = hx !== 0 && hy !== 0;
	if (corner && uniform) {
		// 投影到原对角线（锚点 → 手柄的局部向量）
		const D = { x: hx * g.w, y: hy * g.h };
		const dd = D.x * D.x + D.y * D.y;
		const s = dd > 0 ? (L.x * D.x + L.y * D.y) / dd : 1;
		fx = s;
		fy = s;
	} else {
		if (hx !== 0) fx = (L.x * hx) / g.w;
		if (hy !== 0) fy = (L.y * hy) / g.h;
	}

	const clampScale = (v: number) => Math.min(MAX_LAYER_SCALE, Math.max(MIN_LAYER_SCALE, v));
	// 拖过锚点（比例为负）不做镜像，钳到下限——镜像走 flipH/flipV 显式开关
	const scaleX = hx !== 0 || (corner && uniform) ? clampScale(t0.scaleX * fx) : t0.scaleX;
	const scaleY = hy !== 0 || (corner && uniform) ? clampScale(t0.scaleY * fy) : t0.scaleY;

	// 锚点固定 → 反解新中心
	const nw = base.w * scaleX;
	const nh = base.h * scaleY;
	const back = rotateVec({ x: (hx * nw) / 2, y: (hy * nh) / 2 }, t0.rotation);
	const center = { x: anchor.x + back.x, y: anchor.y + back.y };
	const pos = centerToRatio(center, frame);
	return { ...t0, scaleX, scaleY, x: pos.x, y: pos.y };
}

/** 角度归一到 (-180, 180]（避免旋转手柄绕圈后数值无限增长） */
export function normalizeAngle(deg: number): number {
	let a = deg % 360;
	if (a > 180) a -= 360;
	if (a <= -180) a += 360;
	return a === -0 ? 0 : a;
}

/** 吸附到最近的整档（默认 15°） */
export function snapAngle(deg: number, step: number = ROTATE_SNAP_DEG): number {
	if (!(step > 0)) return deg;
	return Math.round(deg / step) * step;
}

/**
 * 旋转解算：以「按下点 → 当前点」相对中心的角差叠加到起始角。
 * snap=true（按住 Shift）吸附到 15° 档。
 */
export function applyRotate(
	t0: RtcTransform,
	center: RtcPoint,
	start: RtcPoint,
	current: RtcPoint,
	snap: boolean,
): RtcTransform {
	const a0 = Math.atan2(start.y - center.y, start.x - center.x);
	const a1 = Math.atan2(current.y - center.y, current.x - center.x);
	const delta = ((a1 - a0) * 180) / Math.PI;
	let rot = t0.rotation + delta;
	if (snap) rot = snapAngle(rot);
	return { ...t0, rotation: normalizeAngle(rot) };
}

/**
 * 手柄光标：按「手柄方向 + 当前旋转角」折算到最近的 45° 档，返回 CSS resize 光标。
 * （框转了 90° 后，右边手柄在屏幕上是上下方向——光标必须跟着转，否则手感错乱。）
 */
export function handleCursor(handle: RtcHandleId, rotationDeg: number): string {
	const { hx, hy } = handleDir(handle);
	// 屏幕坐标 y 向下：方向角 = atan2(hy, hx) + 旋转
	const deg = normalizeAngle((Math.atan2(hy, hx) * 180) / Math.PI + rotationDeg);
	const idx = ((Math.round(deg / 45) % 8) + 8) % 8; // 0=→ 1=↘ 2=↓ 3=↙ 4=← 5=↖ 6=↑ 7=↗
	switch (idx) {
		case 0:
		case 4:
			return "ew-resize";
		case 1:
		case 5:
			return "nwse-resize";
		case 2:
		case 6:
			return "ns-resize";
		default:
			return "nesw-resize";
	}
}

/* ══════════════════ ④ doc 更新（不可变，commit 契约） ══════════════════ */

/**
 * 写回某片段的变换（不可变；未命中/值未变返回**原 doc 引用** → commit 视为 no-op 不进撤销栈）。
 *
 * ⚠ 只动 `transform` 一个字段：targetStartUs / targetDurationUs / assetId / source 窗口
 * 一律原样带走（预览里拖素材绝不改时间轴位置，§9A 素材唯一性语义）。
 * 变换回到恒等 → **删除字段**（存量文档保持「无 transform = contain 铺满」的干净形态）。
 */
export function withSegmentTransform(doc: RtcDoc, segId: string, next: RtcTransform): RtcDoc {
	let hit = false;
	const tracks = doc.tracks.map((track) => {
		if (!track.segments.some((s) => s.id === segId)) return track;
		const segments = track.segments.map((s) => {
			if (s.id !== segId) return s;
			const cur = segTransform(s);
			if (sameTransform(cur, next)) return s; // 值未变：保持引用
			hit = true;
			// 落库形态（规整 + 等于缺省则不写字段）统一走核心层，与属性面板同一策略
			const stored = storeTransform(next);
			if (stored === undefined) {
				if (s.transform === undefined) return s;
				const { transform: _drop, ...rest } = s;
				return rest;
			}
			return { ...s, transform: stored };
		});
		return segments.some((s, i) => s !== track.segments[i]) ? { ...track, segments } : track;
	});
	return hit ? { ...doc, tracks } : doc;
}

/**
 * 画面点选命中测试：点（画幅坐标像素）是否落在该图层的变换后矩形内。
 * 与选中框同一套几何（segBoxGeom）：逆旋转回未旋转局部坐标再比半宽高——预览「点画面选素材」用。
 * ⚠ 不考虑 crop（裁剪只影响可见区不影响选中热区，与剪映一致的宽松语义）。
 */
export function pointInSegBox(point: RtcPoint, frame: RtcSize, base: RtcSize, t: RtcTransform): boolean {
	const g = segBoxGeom(frame, base, t);
	if (!(g.w > 0) || !(g.h > 0)) return false;
	const local = rotateVec({ x: point.x - g.center.x, y: point.y - g.center.y }, -t.rotation);
	return Math.abs(local.x) <= g.w / 2 && Math.abs(local.y) <= g.h / 2;
}

/** 恒等变换的常量副本（重置画面用；勿直接把 DEFAULT_RTC_TRANSFORM 写进 doc——防被原地改） */
export function resetTransform(): RtcTransform {
	return { ...DEFAULT_RTC_TRANSFORM };
}
