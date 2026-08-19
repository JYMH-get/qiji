/**
 * RtcCropEditor —— 画面裁剪编辑器弹窗（第三批）。
 *
 * 布局：画面预览（图片=<img>、视频=<video> 当前素材直显，contain 适配）+ 裁剪框
 *   （框内拖=移动、四角拖=缩放；比例锁定时四边手柄隐藏、四角保持比例锚定对角）+
 *   比例预设（自由/16:9/9:16/1:1）+ 重置/取消/确定。
 * 数据：全程编辑**本地 crop 草稿**（素材画面归一化坐标，rtcCropCore 口径），
 *   「确定」才一次 commit（withSegmentCrop：规整 + 全 0 删字段；一次编辑=一条 undo）。
 * 几何：预览区尺寸固定（弹窗定宽），画面矩形按素材自然比例算 contain——自然尺寸经媒体元素
 *   元数据探测，未知时按整个预览区近似（元数据到位自动收紧）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { RtcCrop } from "@/types/rtc";
import { CROP_MIN_KEEP, DEFAULT_RTC_CROP, fitCropToRatio, isEmptyCrop, normalizeCrop, withSegmentCrop } from "@/lib/rtcCropCore";
import { useRtcStore } from "@/store/rtcStore";

/** 预览区固定尺寸（弹窗定宽定高，画面在其中 contain） */
const STAGE_W = 560;
const STAGE_H = 340;
const HANDLE = 10;
/** 每个方向至少保留的画面比例（与 rtcCropCore.CROP_MIN_KEEP 同源） */
const MIN_KEEP = CROP_MIN_KEEP;

type RatioPreset = { label: string; ratio: number | null };
const RATIO_PRESETS: RatioPreset[] = [
	{ label: "自由", ratio: null },
	{ label: "16:9", ratio: 16 / 9 },
	{ label: "9:16", ratio: 9 / 16 },
	{ label: "1:1", ratio: 1 },
];

type CropHandle = "nw" | "ne" | "se" | "sw" | "n" | "e" | "s" | "w";
const CORNERS: CropHandle[] = ["nw", "ne", "se", "sw"];
const EDGES: CropHandle[] = ["n", "e", "s", "w"];

interface DragCtx {
	kind: "move" | CropHandle;
	/** 按下那一刻的 crop（整个手势以它为基准） */
	c0: RtcCrop;
	startX: number;
	startY: number;
	/** 画面矩形（stage 像素坐标，手势期间视为不动） */
	rect: { left: number; top: number; w: number; h: number };
}

export function RtcCropEditor({ segId, uri, media, initial, naturalRatioHint, onClose }: {
	segId: string;
	uri: string;
	media: "image" | "video";
	initial: RtcCrop | null;
	/** 已知的素材宽高比（w/h，可缺省——元数据探测兜底） */
	naturalRatioHint?: number | null;
	onClose: () => void;
}) {
	const [crop, setCrop] = useState<RtcCrop>(initial ?? { ...DEFAULT_RTC_CROP });
	const [naturalRatio, setNaturalRatio] = useState<number | null>(naturalRatioHint ?? null);
	const [ratioLock, setRatioLock] = useState<number | null>(null);
	const dragRef = useRef<DragCtx | null>(null);

	// Esc 关闭（不落库）
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [onClose]);

	// 画面矩形：素材在 STAGE 内 contain（自然比例未知按整区近似）
	const ratio = naturalRatio && naturalRatio > 0 ? naturalRatio : STAGE_W / STAGE_H;
	let mediaW = STAGE_W;
	let mediaH = STAGE_W / ratio;
	if (mediaH > STAGE_H) {
		mediaH = STAGE_H;
		mediaW = STAGE_H * ratio;
	}
	const mediaLeft = (STAGE_W - mediaW) / 2;
	const mediaTop = (STAGE_H - mediaH) / 2;

	const recordNatural = useCallback((w: number, h: number) => {
		if (w > 0 && h > 0) setNaturalRatio(w / h);
	}, []);

	/** 应用比例预设：以当前区域中心为锚取该比例的最大区域 */
	const applyRatio = (r: number | null) => {
		setRatioLock(r);
		if (r != null && naturalRatio && naturalRatio > 0) {
			setCrop((c) => fitCropToRatio(c, naturalRatio, r));
		}
	};

	const onDown = (kind: DragCtx["kind"]) => (e: React.PointerEvent) => {
		e.preventDefault();
		e.stopPropagation();
		dragRef.current = {
			kind,
			c0: crop,
			startX: e.clientX,
			startY: e.clientY,
			rect: { left: mediaLeft, top: mediaTop, w: mediaW, h: mediaH },
		};
		try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch { /* 捕获失败仅移出会断，可接受 */ }
	};

	const onMove = (e: React.PointerEvent) => {
		const d = dragRef.current;
		if (!d) return;
		// 位移换算为画面归一化坐标
		const dx = (e.clientX - d.startX) / d.rect.w;
		const dy = (e.clientY - d.startY) / d.rect.h;
		const c0 = d.c0;
		if (d.kind === "move") {
			const w = 1 - c0.left - c0.right;
			const h = 1 - c0.top - c0.bottom;
			const left = Math.min(Math.max(0, c0.left + dx), 1 - w);
			const top = Math.min(Math.max(0, c0.top + dy), 1 - h);
			setCrop({ left, top, right: 1 - left - w, bottom: 1 - top - h });
			return;
		}
		let { left, top, right, bottom } = c0;
		const has = (s: string) => d.kind.includes(s);
		if (ratioLock != null && naturalRatio && naturalRatio > 0 && CORNERS.includes(d.kind as CropHandle)) {
			// 比例锁定的角拖：锚定对角，宽主导、高按比例换算（归一化系数 k = naturalRatio / targetRatio）
			const k = naturalRatio / ratioLock;
			const anchorX = has("w") ? 1 - c0.right : c0.left;
			const anchorY = has("n") ? 1 - c0.bottom : c0.top;
			const px = has("w") ? c0.left + dx : 1 - c0.right + dx;
			let w = has("w") ? anchorX - px : px - anchorX;
			w = Math.min(Math.max(MIN_KEEP, w), has("w") ? anchorX : 1 - anchorX);
			let h = w * k;
			const maxH = has("n") ? anchorY : 1 - anchorY;
			if (h > maxH) { h = maxH; w = h / k; }
			if (h < MIN_KEEP) { h = MIN_KEEP; w = Math.min(h / k, has("w") ? anchorX : 1 - anchorX); }
			left = has("w") ? anchorX - w : anchorX;
			right = has("w") ? 1 - anchorX : 1 - anchorX - w;
			top = has("n") ? anchorY - h : anchorY;
			bottom = has("n") ? 1 - anchorY : 1 - anchorY - h;
			setCrop({ left, top, right, bottom });
			return;
		}
		// 自由拖：各边独立（每个方向至少留 MIN_KEEP）
		if (has("w")) left = Math.min(Math.max(0, c0.left + dx), 1 - c0.right - MIN_KEEP);
		if (has("e")) right = Math.min(Math.max(0, c0.right - dx), 1 - c0.left - MIN_KEEP);
		if (has("n")) top = Math.min(Math.max(0, c0.top + dy), 1 - c0.bottom - MIN_KEEP);
		if (has("s")) bottom = Math.min(Math.max(0, c0.bottom - dy), 1 - c0.top - MIN_KEEP);
		setCrop({ left, top, right, bottom });
	};

	const onUp = () => { dragRef.current = null; };

	const confirm = () => {
		// 「确定」才落库：规整 + 全 0 删字段；值未变 withSegmentCrop 返回原引用 → commit no-op
		useRtcStore.getState().commit((d) => withSegmentCrop(d, segId, normalizeCrop(crop)));
		onClose();
	};

	// 裁剪框在 stage 里的像素位置
	const boxLeft = mediaLeft + crop.left * mediaW;
	const boxTop = mediaTop + crop.top * mediaH;
	const boxW = Math.max(0, (1 - crop.left - crop.right) * mediaW);
	const boxH = Math.max(0, (1 - crop.top - crop.bottom) * mediaH);
	const handlePos: Record<CropHandle, React.CSSProperties> = {
		nw: { left: 0, top: 0 }, ne: { left: "100%", top: 0 }, se: { left: "100%", top: "100%" }, sw: { left: 0, top: "100%" },
		n: { left: "50%", top: 0 }, e: { left: "100%", top: "50%" }, s: { left: "50%", top: "100%" }, w: { left: 0, top: "50%" },
	};
	const cursorOf: Record<CropHandle, string> = {
		nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize",
		n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize",
	};
	const shownHandles: CropHandle[] = ratioLock != null ? CORNERS : [...CORNERS, ...EDGES];

	return (
		<div
			style={{ position: "fixed", inset: 0, zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.6)" }}
			onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
		>
			<div style={{ width: STAGE_W + 32, borderRadius: 10, border: "1px solid rgba(255,255,255,0.12)", background: "#17181d", boxShadow: "0 12px 40px rgba(0,0,0,0.6)", padding: 16 }}>
				<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
					<span style={{ fontSize: 13, fontWeight: 600, color: "#fff" }}>裁剪画面</span>
					<button type="button" onClick={onClose} title="关闭（不保存）" style={{ display: "flex", padding: 4, borderRadius: 5, border: "none", background: "transparent", color: "rgba(255,255,255,0.6)", cursor: "pointer" }}>
						<X size={15} />
					</button>
				</div>

				{/* 预览 + 裁剪框 */}
				<div
					style={{ position: "relative", width: STAGE_W, height: STAGE_H, background: "#000", borderRadius: 6, overflow: "hidden", touchAction: "none" }}
					onPointerMove={onMove}
					onPointerUp={onUp}
					onPointerCancel={onUp}
				>
					{media === "video" ? (
						<video
							src={uri}
							muted
							playsInline
							preload="metadata"
							onLoadedMetadata={(e) => recordNatural(e.currentTarget.videoWidth, e.currentTarget.videoHeight)}
							style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain", pointerEvents: "none" }}
						/>
					) : (
						<img
							src={uri}
							alt=""
							draggable={false}
							onLoad={(e) => recordNatural(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)}
							style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain", pointerEvents: "none" }}
						/>
					)}
					{/* 裁剪框外压暗（超大 box-shadow） */}
					<div
						onPointerDown={onDown("move")}
						style={{
							position: "absolute",
							left: boxLeft,
							top: boxTop,
							width: boxW,
							height: boxH,
							border: "1px solid rgba(255,255,255,0.95)",
							boxShadow: "0 0 0 9999px rgba(0,0,0,0.55)",
							cursor: "move",
							boxSizing: "border-box",
						}}
					>
						{/* 三分线 */}
						{[1, 2].map((i) => (
							<div key={`v${i}`} style={{ position: "absolute", left: `${(i / 3) * 100}%`, top: 0, bottom: 0, width: 1, background: "rgba(255,255,255,0.25)", pointerEvents: "none" }} />
						))}
						{[1, 2].map((i) => (
							<div key={`h${i}`} style={{ position: "absolute", top: `${(i / 3) * 100}%`, left: 0, right: 0, height: 1, background: "rgba(255,255,255,0.25)", pointerEvents: "none" }} />
						))}
						{shownHandles.map((h) => (
							<div
								key={h}
								onPointerDown={onDown(h)}
								style={{
									position: "absolute",
									...handlePos[h],
									width: HANDLE,
									height: HANDLE,
									marginLeft: -HANDLE / 2,
									marginTop: -HANDLE / 2,
									borderRadius: 2,
									background: "#fff",
									border: "1px solid rgba(0,0,0,0.5)",
									cursor: cursorOf[h],
								}}
							/>
						))}
					</div>
				</div>

				{/* 比例预设 + 操作 */}
				<div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 12 }}>
					{RATIO_PRESETS.map((p) => {
						const active = ratioLock === p.ratio;
						return (
							<button
								key={p.label}
								type="button"
								onClick={() => applyRatio(p.ratio)}
								style={{
									height: 24,
									padding: "0 10px",
									borderRadius: 5,
									fontSize: 11,
									cursor: "pointer",
									border: active ? "1px solid rgba(139,92,246,0.6)" : "1px solid rgba(255,255,255,0.12)",
									background: active ? "rgba(139,92,246,0.18)" : "transparent",
									color: active ? "#d6c8ff" : "rgba(255,255,255,0.7)",
								}}
								title={p.ratio == null ? "自由裁剪（八向手柄）" : `锁定保留区域为 ${p.label}（按素材像素比例）`}
							>
								{p.label}
							</button>
						);
					})}
					<span style={{ flex: 1 }} />
					<button
						type="button"
						onClick={() => { setCrop({ ...DEFAULT_RTC_CROP }); setRatioLock(null); }}
						style={{ height: 26, padding: "0 12px", borderRadius: 6, fontSize: 12, cursor: "pointer", border: "1px solid rgba(255,255,255,0.14)", background: "transparent", color: "rgba(255,255,255,0.75)" }}
					>
						重置
					</button>
					<button
						type="button"
						onClick={onClose}
						style={{ height: 26, padding: "0 12px", borderRadius: 6, fontSize: 12, cursor: "pointer", border: "1px solid rgba(255,255,255,0.14)", background: "transparent", color: "rgba(255,255,255,0.75)" }}
					>
						取消
					</button>
					<button
						type="button"
						onClick={confirm}
						style={{ height: 26, padding: "0 14px", borderRadius: 6, fontSize: 12, cursor: "pointer", border: "1px solid rgba(139,92,246,0.6)", background: "rgba(139,92,246,0.25)", color: "#e6dcff" }}
					>
						确定
					</button>
				</div>
				<div style={{ marginTop: 8, fontSize: 10, lineHeight: 1.6, color: "rgba(255,255,255,0.38)" }}>
					{isEmptyCrop(normalizeCrop(crop)) ? "当前未裁剪（确定=清除裁剪）。" : "裁剪只影响画面显示区域，不改动素材文件；导出剪映草稿时落到素材的 crop 上。"}
				</div>
			</div>
		</div>
	);
}
