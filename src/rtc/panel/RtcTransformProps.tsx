/**
 * RtcTransformProps —— 右栏「画面」数值设置（对标剪映「画面 · 基础」那一栏）。
 *
 * 覆盖：缩放（滑杆+百分比框、等比开关、解锁后 X/Y 分离）、位置 X/Y（像素，带步进）、
 *       旋转（数值框 `0.00°` + 可拖转盘）、水平/垂直镜像、不透明度（滑杆+百分比框）、
 *       一排对齐按钮（左/水平居中/右 + 上/垂直居中/下）、每组一个**真能用**的重置。
 *
 * ⚠ 显示像素 / 内部比例（换算约定，勿混）：
 *   片段存的 `RtcTransform.x/y` 是**画幅宽/高的比例**（0=居中、x 正向右、y 正向下），
 *   面板按 `像素 = 比例 × 画幅宽(高)` 显示与输入（见 lib/rtcTransformCore 的 ratioToPx/pxToRatio）。
 *   这样切画幅档（1080P→4K、16:9→9:16）素材不失位。画幅取 `docCanvas(doc)`（缺省 1920×1080）。
 *
 * ⚠ 写入纪律（§9A 锁定）：
 *   - 一切写入走 `commitSegmentPatch` → `rtcStore.commit`（唯一写入路径），且**只碰 transform 字段**，
 *     绝不动 targetStartUs / targetDurationUs / assetId / source 窗口；
 *   - 滑杆**拖动过程不 commit**（每帧一次会把撤销栈冲垮）：拖动中走本地 draft 预览，
 *     pointerup / keyup / blur 才落定一次 → 一次拖动 = 一步撤销；数字框回车或失焦才 commit；
 *   - 非法输入（空/NaN/越界）回退原值、不报错、不写库（parseNumeric 返 null 即回退）；
 *   - 规整后等于缺省变换 → 写 `undefined`（storeTransform），项目文件里与「从未调过」同形。
 *
 * ── 第二批：关键帧（菱形按钮）────────────────────────────────────────────
 *   - 可打关键帧的属性行尾有**菱形按钮**：当前时刻（容差 KF_TOLERANCE_US）有帧=实心◆、无=空心◇，
 *     点击=toggleKeyframeAtPlayhead（有则删无则加，加帧取当下生效值=画面零跳变）；
 *   - **改属性值时若该属性已有关键帧 → 在播放头时刻写帧而非改基础值**（applyTransformPatchAt
 *     统一分账；无关键帧片段与旧 write 路径逐字节一致，零回归）；
 *   - 有关键帧的属性，行内显示**播放头时刻的采样值**（effectiveTransformAt）——面板订阅
 *     playheadUs 仅在片段带关键帧时生效（无关键帧片段选择器恒返 0，播放中零重渲染）；
 *   - scale 关键帧是等比单值（scaleX 基准）：解锁 X/Y 后单独调 scaleY 仍写基础值（比例跟随）。
 *
 * ⚠ 本轮不做（别画不接线的假控件）：
 *   - **混合模式**：`RtcTransform` 目前无 blendMode 字段（types/rtc.ts 本轮不动），做了没处存 →
 *     待 types 扩 `blendMode` 字段后再补（预览侧对应 CSS `mix-blend-mode`，导出侧对应剪映混合素材）。
 *
 * 接线（插进 RtcPropertyPanel 的 media 片段分支即可，组件自带「非画面片段返回 null」的守卫）：
 *   import { RtcTransformProps } from "./panel/RtcTransformProps";
 *   // PropsPage 里：
 *   if (sel.seg.kind === "media") {
 *     return (<><RtcMediaProps seg={sel.seg} track={sel.track} segIndex={sel.segIndex} /><RtcTransformProps segId={sel.seg.id} /></>);
 *   }
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useRtcStore } from "@/store/rtcStore";
import { docCanvas, segTransform, DEFAULT_RTC_TRANSFORM, type RtcKfProp, type RtcSegment, type RtcTrack, type RtcTransform } from "@/types/rtc";
import {
	alignOffsetRatio,
	containFit,
	normalizeRotation,
	parseNumeric,
	percentToScale,
	pxToRatio,
	ratioToPx,
	scaleToPercent,
	type AlignKind,
} from "@/lib/rtcTransformCore";
/* ── 第二批：关键帧（菱形按钮 + 关键帧感知写入 + 播放头时刻采样显示） ── */
import {
	KF_TOLERANCE_US,
	applyTransformPatchAt,
	effectiveTransformAt,
	hasSegKeyframes,
	keyframeNear,
	segRelUs,
	toggleKeyframeAtPlayhead,
} from "@/lib/rtcKeyframes";

/* ── 样式（与 RtcMediaProps 同款内联风格） ────────────────────────────── */

const rowSt: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, fontSize: 11, color: "rgba(255,255,255,0.6)" };
const groupSt: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 8, paddingTop: 8, borderTop: "1px solid rgba(255,255,255,0.07)" };
const headSt: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 12, color: "rgba(255,255,255,0.85)" };
const numSt: React.CSSProperties = { width: 74, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 6, color: "#fff", padding: "4px 6px", fontSize: 12, outline: "none", textAlign: "right" };
const miniBtn: React.CSSProperties = { fontSize: 10, color: "rgba(255,255,255,0.55)", background: "transparent", border: "1px solid rgba(255,255,255,0.14)", borderRadius: 5, padding: "2px 6px", cursor: "pointer" };

function toggleBtnSt(on: boolean): React.CSSProperties {
	return {
		flex: 1,
		fontSize: 11,
		padding: "5px 4px",
		borderRadius: 6,
		cursor: "pointer",
		border: `1px solid ${on ? "rgba(167,139,250,0.7)" : "rgba(255,255,255,0.14)"}`,
		background: on ? "rgba(167,139,250,0.18)" : "rgba(255,255,255,0.05)",
		color: on ? "#ddd6fe" : "rgba(255,255,255,0.75)",
	};
}

/* ── 受控小控件 ──────────────────────────────────────────────────────── */

/**
 * 滑杆：拖动中只走本地 draft 预览，**松手/抬键/失焦才 commit 一次**（一次拖动=一步撤销）。
 * onPreview 可选——需要让同组数字框跟着实时变的场景传它。
 */
function DragSlider({
	value, min, max, step, onPreview, onCommit, title,
}: {
	value: number; min: number; max: number; step: number;
	onPreview?: (v: number) => void; onCommit: (v: number) => void; title?: string;
}) {
	const [draft, setDraft] = useState<number | null>(null);
	const shown = draft ?? value;
	const settle = () => {
		if (draft == null) return;
		const v = draft;
		setDraft(null);
		onPreview?.(Number.NaN); // 通知父级清预览（NaN=无预览，父级据此回退到 store 值）
		onCommit(v);
	};
	return (
		<input
			type="range"
			min={min}
			max={max}
			step={step}
			value={shown}
			title={title}
			onChange={(e) => {
				const v = Number(e.target.value);
				setDraft(v);
				onPreview?.(v);
			}}
			onPointerUp={settle}
			onPointerCancel={settle}
			onKeyUp={settle}
			onBlur={settle}
			style={{ flex: 1, minWidth: 0 }}
		/>
	);
}

/** 数字输入框：草稿式——回车/失焦才提交；非法输入回退原值不写库。format 控制静态显示形态（如 `0.00`） */
function NumBox({
	value, step, suffix, onCommit, title, width, format,
}: {
	value: number; step?: number; suffix?: string; onCommit: (v: number) => void; title?: string; width?: number;
	format?: (v: number) => string;
}) {
	const [draft, setDraft] = useState<string | null>(null);
	// 外部值变化（commit 落定 / 切片段 / 对齐按钮改值）→ 丢弃草稿显示新值
	useEffect(() => { setDraft(null); }, [value]);
	const settle = () => {
		if (draft == null) return;
		const n = parseNumeric(draft);
		setDraft(null); // 非法 → 直接回退到原值显示（不报错、不写库）
		if (n != null && n !== value) onCommit(n);
	};
	return (
		<span style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
			<input
				type="text"
				inputMode="decimal"
				value={draft ?? (format ? format(value) : String(value))}
				title={title}
				onChange={(e) => setDraft(e.target.value)}
				onBlur={settle}
				onKeyDown={(e) => {
					if (e.key === "Enter") (e.target as HTMLInputElement).blur();
					else if (e.key === "Escape") { setDraft(null); (e.target as HTMLInputElement).blur(); }
					else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && step) {
						// 步进：直接落定一次（键盘微调=一步撤销，与剪映数值框手感一致）
						e.preventDefault();
						const base = parseNumeric(draft ?? String(value));
						if (base == null) return;
						setDraft(null);
						onCommit(base + (e.key === "ArrowUp" ? step : -step));
					}
				}}
				style={{ ...numSt, ...(width ? { width } : {}) }}
			/>
			{suffix ? <span style={{ fontSize: 11, color: "rgba(255,255,255,0.45)" }}>{suffix}</span> : null}
		</span>
	);
}

/** ── 第二批：关键帧菱形按钮——当前时刻有帧=实心◆ / 无=空心◇（该属性有任何帧时着紫色） */
function KfDiamond({ active, filled, onClick, title }: { active: boolean; filled: boolean; onClick: () => void; title?: string }) {
	return (
		<button
			type="button"
			title={title ?? "在播放头处添加/移除关键帧（该属性有关键帧时，改值=在当前时刻写帧）"}
			onClick={onClick}
			style={{
				width: 18,
				height: 18,
				flexShrink: 0,
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				border: "none",
				background: "transparent",
				cursor: "pointer",
				padding: 0,
				fontSize: 12,
				lineHeight: 1,
				color: filled ? "#a78bfa" : active ? "rgba(167,139,250,0.75)" : "rgba(255,255,255,0.35)",
			}}
		>
			{filled ? "◆" : "◇"}
		</button>
	);
}

/** 旋转转盘：拖动实时预览、松手落定一次；按住 Shift 吸附 15° */
function RotateDial({ deg, onPreview, onCommit }: { deg: number; onPreview: (v: number) => void; onCommit: (v: number) => void }) {
	const ref = useRef<HTMLDivElement | null>(null);
	const dragging = useRef(false);
	const last = useRef(deg);

	const angleAt = (e: React.PointerEvent) => {
		const el = ref.current;
		if (!el) return deg;
		const r = el.getBoundingClientRect();
		const dx = e.clientX - (r.left + r.width / 2);
		const dy = e.clientY - (r.top + r.height / 2);
		// 屏幕 y 轴向下：atan2(dy,dx)+90 → 正上方为 0、顺时针为正（与我们的 rotation 同向）
		const raw = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
		return normalizeRotation(e.shiftKey ? Math.round(raw / 15) * 15 : raw);
	};

	const rad = ((deg - 90) * Math.PI) / 180; // 画手柄用：0° 指向正上方
	return (
		<div
			ref={ref}
			title="拖动调整角度（按住 Shift 吸附 15°）"
			onPointerDown={(e) => {
				dragging.current = true;
				(e.target as HTMLElement).setPointerCapture?.(e.pointerId);
				const v = angleAt(e);
				last.current = v;
				onPreview(v);
			}}
			onPointerMove={(e) => {
				if (!dragging.current) return;
				const v = angleAt(e);
				last.current = v;
				onPreview(v);
			}}
			onPointerUp={() => {
				if (!dragging.current) return;
				dragging.current = false;
				onPreview(Number.NaN);
				onCommit(last.current);
			}}
			onPointerCancel={() => { dragging.current = false; onPreview(Number.NaN); }}
			style={{
				width: 28, height: 28, borderRadius: "50%", position: "relative", cursor: "grab", flexShrink: 0,
				border: "1px solid rgba(255,255,255,0.2)", background: "rgba(255,255,255,0.05)",
			}}
		>
			<span style={{ position: "absolute", left: "50%", top: "50%", width: 2, height: 2, marginLeft: -1, marginTop: -1, borderRadius: "50%", background: "rgba(255,255,255,0.35)" }} />
			<span
				style={{
					position: "absolute", width: 5, height: 5, borderRadius: "50%", background: "#a78bfa",
					left: `calc(50% + ${Math.cos(rad) * 10}px - 2.5px)`,
					top: `calc(50% + ${Math.sin(rad) * 10}px - 2.5px)`,
				}}
			/>
		</div>
	);
}

/* ── 主组件 ──────────────────────────────────────────────────────────── */

interface Located {
	seg: RtcSegment;
	track: RtcTrack;
}

/** 组件自带守卫：片段不存在 / 非 media / 音频（无画面）→ 渲染 null（接线端零判断） */
export function RtcTransformProps({ segId }: { segId: string }) {
	const doc = useRtcStore((s) => s.doc);

	const found = useMemo<Located | null>(() => {
		if (!doc) return null;
		for (const track of doc.tracks) {
			const seg = track.segments.find((s) => s.id === segId);
			if (seg) return { seg, track };
		}
		return null;
	}, [doc, segId]);

	const seg = found?.seg ?? null;
	const track = found?.track ?? null;
	const media = seg ? seg.media || (track?.type === "audio" ? "audio" : "video") : null;
	const visual = !!seg && seg.kind === "media" && media !== "audio" && track?.type !== "audio";

	const canvas = doc ? docCanvas(doc) : { width: 1920, height: 1080 };
	const t = seg ? segTransform(seg) : DEFAULT_RTC_TRANSFORM;

	/* 素材原始宽高比：对齐按钮要按 contain 后的**显示尺寸**贴边；探测不到就按「铺满画幅」兜底 */
	const [mediaAspect, setMediaAspect] = useState<number | null>(null);
	const uri = seg?.uri;
	useEffect(() => {
		setMediaAspect(null);
		if (!uri || !visual) return;
		let alive = true;
		if (media === "image") {
			const img = new Image();
			img.onload = () => { if (alive && img.naturalWidth > 0 && img.naturalHeight > 0) setMediaAspect(img.naturalWidth / img.naturalHeight); };
			img.src = uri;
			return () => { alive = false; };
		}
		const v = document.createElement("video");
		v.preload = "metadata";
		v.onloadedmetadata = () => { if (alive && v.videoWidth > 0 && v.videoHeight > 0) setMediaAspect(v.videoWidth / v.videoHeight); };
		v.src = uri;
		return () => { alive = false; v.src = ""; };
	}, [uri, media, visual]);

	/* ── 第二批：关键帧 ──
	 * 面板只在片段**带关键帧**时才订阅 playheadUs（选择器对无关键帧片段恒返 0——播放中零重渲染）；
	 * 有关键帧的属性行显示播放头时刻的采样值，菱形按钮按容差判定实心/空心。 */
	const kfActive = !!seg && hasSegKeyframes(seg);
	const playheadUs = useRtcStore((s) => (kfActive ? s.playheadUs : 0));
	const relUs = seg && kfActive ? segRelUs(seg, playheadUs) : 0;
	/** 显示基准：有关键帧 → 播放头时刻的生效值；无 → 基础 transform（引用同 t，零变化） */
	const eff = seg && kfActive ? effectiveTransformAt(seg, relUs) : t;
	const kfHas = (p: RtcKfProp) => ((seg?.keyframes?.[p]?.length ?? 0) > 0);
	const kfFilled = (p: RtcKfProp) => !!seg && keyframeNear(seg.keyframes?.[p], relUs, KF_TOLERANCE_US) != null;
	const toggleKf = (p: RtcKfProp) => {
		if (!seg) return;
		const ph = useRtcStore.getState().playheadUs; // 现读（面板未订阅时也要拿到真播放头）
		useRtcStore.getState().commit((d) => toggleKeyframeAtPlayhead(d, seg.id, p, ph));
	};

	/* 拖动预览（滑杆/转盘拖动中只改这里，松手才 commit）——NaN/null = 无预览，读 store 真值 */
	const [preview, setPreview] = useState<Partial<Record<"scaleX" | "scaleY" | "rotation" | "opacity", number>>>({});
	const putPreview = (k: "scaleX" | "scaleY" | "rotation" | "opacity") => (v: number) =>
		setPreview((p) => (Number.isFinite(v) ? { ...p, [k]: v } : { ...p, [k]: undefined }));
	// 切片段 → 清空预览，防上一段的草稿值串到新片段上
	useEffect(() => { setPreview({}); }, [segId]);
	const view: RtcTransform = {
		...eff,
		scaleX: preview.scaleX ?? eff.scaleX,
		scaleY: preview.scaleY ?? eff.scaleY,
		rotation: preview.rotation ?? eff.rotation,
		opacity: preview.opacity ?? eff.opacity,
	};

	/* 等比缩放：数据层无该字段 → 由「两轴是否同值」派生 + 本地解锁偏好（解锁后才分离 X/Y） */
	const [uniformPref, setUniformPref] = useState(true);
	useEffect(() => { setUniformPref(true); }, [segId]);
	const uniform = uniformPref && t.scaleX === t.scaleY;

	/** 唯一写入口（第二批改为**关键帧感知**）：某属性已有关键帧 → 在播放头时刻写帧（基础值不动）；
	 *  无关键帧属性 → 并进基础 transform（applyTransformPatchAt 内部经 storeTransform 规整、
	 *  缺省形态写 undefined——与旧 write 路径逐字节一致，无关键帧片段零回归）。 */
	const write = (patch: Partial<RtcTransform>) => {
		if (!seg) return;
		const ph = useRtcStore.getState().playheadUs;
		useRtcStore.getState().commit((d) => applyTransformPatchAt(d, seg.id, patch, ph));
	};

	if (!visual || !seg) return null;

	const fit = containFit(mediaAspect, canvas.width / canvas.height);
	const align = (kind: AlignKind) => {
		const v = alignOffsetRatio(kind, fit, view);
		write(kind === "left" || kind === "centerX" || kind === "right" ? { x: v } : { y: v });
	};
	// 等比开时一次写两轴；解锁后只写被拖的那一轴
	const setScale = (axis: "scaleX" | "scaleY", v: number) => {
		const s = percentToScale(v);
		write(uniform ? { scaleX: s, scaleY: s } : axis === "scaleX" ? { scaleX: s } : { scaleY: s });
	};

	const alignBtns: { kind: AlignKind; glyph: string; label: string }[] = [
		{ kind: "left", glyph: "⇤", label: "左对齐" },
		{ kind: "centerX", glyph: "↔", label: "水平居中" },
		{ kind: "right", glyph: "⇥", label: "右对齐" },
		{ kind: "top", glyph: "⤒", label: "顶对齐" },
		{ kind: "centerY", glyph: "↕", label: "垂直居中" },
		{ kind: "bottom", glyph: "⤓", label: "底对齐" },
	];

	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "0 12px 20px" }}>
			{/* ── 位置大小 ── */}
			<div style={groupSt}>
				<div style={headSt}>
					<span>画面 · 位置大小</span>
					<button
						type="button"
						style={miniBtn}
						title="缩放/位置/旋转/镜像 恢复默认（contain 居中铺满、不旋转）"
						onClick={() => write({ scaleX: 1, scaleY: 1, x: 0, y: 0, rotation: 0, flipH: undefined, flipV: undefined })}
					>重置</button>
				</div>

				{/* 缩放（等比时一根滑杆控两轴） */}
				<div style={rowSt}>
					<span style={{ width: 40, flexShrink: 0 }}>{uniform ? "缩放" : "缩放 X"}</span>
					<DragSlider
						value={scaleToPercent(view.scaleX)}
						min={1} max={400} step={1}
						title="缩放（100% = 在画幅内铺满）"
						onPreview={(v) => {
							const s = Number.isFinite(v) ? percentToScale(v) : Number.NaN;
							putPreview("scaleX")(s);
							if (uniform) putPreview("scaleY")(s);
						}}
						onCommit={(v) => setScale("scaleX", v)}
					/>
					<NumBox value={scaleToPercent(view.scaleX)} step={1} suffix="%" onCommit={(v) => setScale("scaleX", v)} title="缩放百分比（1–1000）" />
					<KfDiamond active={kfHas("scale")} filled={kfFilled("scale")} onClick={() => toggleKf("scale")} title="缩放关键帧（等比单值；在播放头处添加/移除）" />
				</div>
				{!uniform ? (
					<div style={rowSt}>
						<span style={{ width: 40, flexShrink: 0 }}>缩放 Y</span>
						<DragSlider
							value={scaleToPercent(view.scaleY)}
							min={1} max={400} step={1}
							title="垂直缩放"
							onPreview={(v) => putPreview("scaleY")(Number.isFinite(v) ? percentToScale(v) : Number.NaN)}
							onCommit={(v) => write({ scaleY: percentToScale(v) })}
						/>
						<NumBox value={scaleToPercent(view.scaleY)} step={1} suffix="%" onCommit={(v) => write({ scaleY: percentToScale(v) })} title="垂直缩放百分比" />
					</div>
				) : null}
				<div style={rowSt}>
					<span>等比缩放</span>
					<label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }} title="关闭后可分别设置 X / Y 缩放（导出草稿的 uniform_scale 随之置 false）">
						<input
							type="checkbox"
							checked={uniform}
							onChange={(e) => {
								setUniformPref(e.target.checked);
								if (e.target.checked && t.scaleY !== t.scaleX) write({ scaleY: t.scaleX });
							}}
							style={{ cursor: "pointer" }}
						/>
					</label>
				</div>

				{/* 位置（像素显示，内部存比例） */}
				<div style={rowSt}>
					<span style={{ width: 40, flexShrink: 0 }}>位置</span>
					<span style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: "auto" }}>
						<span style={{ fontSize: 11, color: "rgba(255,255,255,0.45)" }}>X</span>
						<NumBox
							value={ratioToPx(eff.x, canvas.width)}
							step={1}
							onCommit={(px) => write({ x: pxToRatio(px, canvas.width) })}
							title={`水平位置（像素，0=居中；画幅宽 ${canvas.width}）`}
						/>
						<KfDiamond active={kfHas("x")} filled={kfFilled("x")} onClick={() => toggleKf("x")} title="位置 X 关键帧（在播放头处添加/移除）" />
						<span style={{ fontSize: 11, color: "rgba(255,255,255,0.45)" }}>Y</span>
						<NumBox
							value={ratioToPx(eff.y, canvas.height)}
							step={1}
							onCommit={(px) => write({ y: pxToRatio(px, canvas.height) })}
							title={`垂直位置（像素，0=居中、正数向下；画幅高 ${canvas.height}）`}
						/>
						<KfDiamond active={kfHas("y")} filled={kfFilled("y")} onClick={() => toggleKf("y")} title="位置 Y 关键帧（在播放头处添加/移除）" />
					</span>
				</div>

				{/* 旋转（数值框 + 转盘） */}
				<div style={rowSt}>
					<span style={{ width: 40, flexShrink: 0 }}>旋转</span>
					<span style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: "auto" }}>
						<NumBox
							value={Number(view.rotation.toFixed(2))}
							format={(v) => v.toFixed(2)}
							step={1}
							suffix="°"
							onCommit={(v) => write({ rotation: normalizeRotation(v) })}
							title="顺时针旋转角度（0–360）"
						/>
						<RotateDial
							deg={view.rotation}
							onPreview={putPreview("rotation")}
							onCommit={(v) => write({ rotation: v })}
						/>
						<KfDiamond active={kfHas("rotation")} filled={kfFilled("rotation")} onClick={() => toggleKf("rotation")} title="旋转关键帧（在播放头处添加/移除）" />
					</span>
				</div>

				{/* 镜像 */}
				<div style={{ display: "flex", gap: 6 }}>
					<button type="button" style={toggleBtnSt(!!t.flipH)} onClick={() => write({ flipH: t.flipH ? undefined : true })} title="水平镜像">⇄ 水平镜像</button>
					<button type="button" style={toggleBtnSt(!!t.flipV)} onClick={() => write({ flipV: t.flipV ? undefined : true })} title="垂直镜像">⇅ 垂直镜像</button>
				</div>

				{/* 对齐（按 contain 显示尺寸×当前缩放贴边） */}
				<div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
					<div style={{ display: "flex", gap: 4 }}>
						{alignBtns.map((b) => (
							<button
								key={b.kind}
								type="button"
								onClick={() => align(b.kind)}
								title={b.label}
								style={{ flex: 1, fontSize: 12, padding: "4px 0", borderRadius: 6, cursor: "pointer", border: "1px solid rgba(255,255,255,0.14)", background: "rgba(255,255,255,0.05)", color: "rgba(255,255,255,0.8)" }}
							>{b.glyph}</button>
						))}
					</div>
					<span style={{ fontSize: 10, color: "rgba(255,255,255,0.35)" }}>
						对齐按当前缩放后的画面尺寸贴边{mediaAspect == null ? "（素材尺寸未探测到，按铺满画幅计算）" : ""}
					</span>
				</div>
			</div>

			{/* ── 混合（本轮只有不透明度；混合模式待 types 扩 blendMode 字段后补，见文件头） ── */}
			<div style={groupSt}>
				<div style={headSt}>
					<span>画面 · 混合</span>
					<button type="button" style={miniBtn} title="不透明度恢复 100%" onClick={() => write({ opacity: 1 })}>重置</button>
				</div>
				<div style={rowSt}>
					<span style={{ width: 40, flexShrink: 0 }}>不透明</span>
					<DragSlider
						value={Math.round(view.opacity * 100)}
						min={0} max={100} step={1}
						title="不透明度（0–100%）"
						onPreview={(v) => putPreview("opacity")(Number.isFinite(v) ? v / 100 : Number.NaN)}
						onCommit={(v) => write({ opacity: v / 100 })}
					/>
					<NumBox value={Math.round(view.opacity * 100)} step={1} suffix="%" onCommit={(v) => write({ opacity: v / 100 })} title="不透明度百分比" />
					<KfDiamond active={kfHas("opacity")} filled={kfFilled("opacity")} onClick={() => toggleKf("opacity")} title="不透明度关键帧（在播放头处添加/移除）" />
				</div>
			</div>
		</div>
	);
}
