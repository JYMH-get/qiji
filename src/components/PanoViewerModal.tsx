/**
 * PanoViewerModal —— 720°全景查看器（App 根 lazy 挂载，panoStore 唤起）。
 *
 * WebGL equirect 渲染（lib/panoRender，零依赖）：拖动=转动视角、滚轮=视场角缩放；
 * 右下 HUD 显示 横/纵/视场；顶部工具条：截取当前视角 / 四视图 / 六视图 / 八视图 / 十二视图。
 * 截图=离屏渲染 PNG → **懒上传**本地暂存 → 单张落图片节点、成套落分镜组节点（panoramaOp）。
 * ⚠ 图像字节 fetch→createImageBitmap（asset:// 直喂纹理会 CORS 失败——涂鸦同款教训）；
 * ⚠ 关闭必须 destroy（WebView2 WebGL context 有数量上限——调研④共同工程注意）。
 */
import { useEffect, useRef, useState } from "react";
import { Bone, Camera, Loader2, X } from "lucide-react";
import { usePanoStore } from "@/store/panoStore";
import { useCanvasStore } from "@/store/canvasStore";
import { openDirectorStage } from "@/store/directorStore";
import { savePanoSnapshots } from "@/canvas/panoramaOp";
import { PanoRenderer, renderPanoSnapshots } from "@/lib/panoRender";
import { normYaw, VIEW_SET_LABELS, viewSet, type PanoViewSetKind } from "@/lib/panoView";

export default function PanoViewerModal() {
	const session = usePanoStore((s) => s.session);
	const close = usePanoStore((s) => s.close);

	const canvasRef = useRef<HTMLCanvasElement>(null);
	const rendererRef = useRef<PanoRenderer | null>(null);
	const bitmapRef = useRef<ImageBitmap | null>(null);
	const viewRef = useRef({ yaw: 0, pitch: 0, fov: 60 });
	const [hud, setHud] = useState({ yaw: 0, pitch: 0, fov: 60 });
	const [err, setErr] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState<string | null>(null);
	const [dragging, setDragging] = useState(false);

	// ── 会话开合：载图 → 建渲染器 → 首帧 ──
	useEffect(() => {
		if (!session) return;
		setErr(null);
		setLoading(true);
		viewRef.current = { yaw: 0, pitch: 0, fov: 60 };
		setHud({ yaw: 0, pitch: 0, fov: 60 });
		let alive = true;
		(async () => {
			let bmp: ImageBitmap | null = null;
			for (const uri of [session.uri, session.fallbackUri]) {
				if (!uri) continue;
				try {
					const resp = await fetch(uri);
					if (!resp.ok) throw new Error();
					bmp = await createImageBitmap(await resp.blob());
					break;
				} catch { /* 试下一个源 */ }
			}
			if (!alive) return;
			if (!bmp) { setErr("全景图加载失败（无法读取图像字节）"); setLoading(false); return; }
			bitmapRef.current = bmp;
			try {
				const canvas = canvasRef.current!;
				const r = new PanoRenderer(canvas);
				r.setImage(bmp);
				rendererRef.current = r;
				draw();
				setLoading(false);
			} catch (e) {
				setErr(e instanceof Error ? e.message : "WebGL 初始化失败");
				setLoading(false);
			}
		})();
		return () => {
			alive = false;
			rendererRef.current?.destroy();
			rendererRef.current = null;
			bitmapRef.current = null;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [session]);

	const draw = () => {
		const r = rendererRef.current;
		const canvas = canvasRef.current;
		if (!r || !canvas) return;
		// 画布跟随显示尺寸（DPR 上限 2 防大屏爆内存）
		const dpr = Math.min(2, window.devicePixelRatio || 1);
		const w = Math.round(canvas.clientWidth * dpr);
		const h = Math.round(canvas.clientHeight * dpr);
		if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
		const v = viewRef.current;
		r.render(v.yaw, v.pitch, v.fov);
		setHud({ yaw: Math.round(normYaw(v.yaw)), pitch: Math.round(v.pitch), fov: Math.round(v.fov) });
	};

	// Esc 关闭
	useEffect(() => {
		if (!session) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") { e.stopPropagation(); close(); }
		};
		window.addEventListener("keydown", onKey, { capture: true });
		return () => window.removeEventListener("keydown", onKey, { capture: true });
	}, [session, close]);

	// 滚轮=视场角（native 非 passive）
	useEffect(() => {
		const el = canvasRef.current;
		if (!el || !session) return;
		const onWheel = (e: WheelEvent) => {
			e.preventDefault();
			const v = viewRef.current;
			v.fov = Math.max(25, Math.min(110, v.fov * Math.exp(e.deltaY * 0.001)));
			draw();
		};
		el.addEventListener("wheel", onWheel, { passive: false });
		return () => el.removeEventListener("wheel", onWheel);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [session, loading]);

	if (!session) return null;

	const beginDrag = (e: React.MouseEvent) => {
		if (e.button !== 0) return;
		e.preventDefault();
		setDragging(true);
		const start = { x: e.clientX, y: e.clientY, yaw: viewRef.current.yaw, pitch: viewRef.current.pitch };
		const onMove = (me: MouseEvent) => {
			const v = viewRef.current;
			const k = 0.12 * (v.fov / 60); // 视场越窄拖动越细
			v.yaw = start.yaw - (me.clientX - start.x) * k;
			v.pitch = Math.max(-89, Math.min(89, start.pitch + (me.clientY - start.y) * k));
			draw();
		};
		const onUp = () => {
			window.removeEventListener("mousemove", onMove);
			window.removeEventListener("mouseup", onUp);
			setDragging(false);
		};
		window.addEventListener("mousemove", onMove);
		window.addEventListener("mouseup", onUp);
	};

	const baseName = (session.name || "全景").replace(/\.[a-z0-9]+$/i, "");

	/** 截取当前视角（按查看画布比例 16:9 高清出图） */
	const captureCurrent = async () => {
		const bmp = bitmapRef.current;
		if (!bmp || busy) return;
		setBusy("当前视角");
		try {
			const v = viewRef.current;
			const canvas = document.createElement("canvas");
			canvas.width = 1600;
			canvas.height = 900;
			const r = new PanoRenderer(canvas);
			try {
				r.setImage(bmp);
				r.render(v.yaw, v.pitch, v.fov);
				const blob = await new Promise<Blob>((resolve, reject) =>
					canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("导出失败"))), "image/png"));
				const label = `横${Math.round(normYaw(v.yaw))}纵${Math.round(v.pitch)}`;
				const errMsg = await savePanoSnapshots([blob], [label], { sourceNodeId: session.sourceNodeId, baseName, setTitle: "当前视角" });
				if (errMsg) alert(errMsg);
			} finally {
				r.destroy();
			}
		} catch (e) {
			alert(`截取失败：${e instanceof Error ? e.message : "未知错误"}`);
		} finally {
			setBusy(null);
		}
	};

	/** 批量视图截取 → 分镜组节点 */
	const captureSet = async (kind: PanoViewSetKind) => {
		const bmp = bitmapRef.current;
		if (!bmp || busy) return;
		setBusy(VIEW_SET_LABELS[kind]);
		try {
			const views = viewSet(kind);
			const blobs = await renderPanoSnapshots(bmp, views, 1024);
			const errMsg = await savePanoSnapshots(blobs, views.map((v) => v.label), {
				sourceNodeId: session.sourceNodeId, baseName, setTitle: VIEW_SET_LABELS[kind],
			});
			if (errMsg) alert(errMsg);
		} catch (e) {
			alert(`${VIEW_SET_LABELS[kind]}截取失败：${e instanceof Error ? e.message : "未知错误"}`);
		} finally {
			setBusy(null);
		}
	};

	const btn = "flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs text-white/75 hover:text-white bg-white/8 hover:bg-white/16 cursor-pointer whitespace-nowrap disabled:opacity-50 disabled:cursor-wait";

	return (
		<div style={{ position: "fixed", inset: 0, zIndex: 100270, background: "rgba(4,6,10,0.9)", display: "flex", flexDirection: "column" }}>
			{/* 顶部工具条 */}
			<div style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", background: "rgba(14,17,27,0.96)", borderBottom: "1px solid rgba(255,255,255,0.09)", flexWrap: "wrap" }}>
				<span style={{ fontSize: 13, color: "rgba(255,255,255,0.85)", fontWeight: 600, marginRight: 6, maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
					720°全景 · {session.name || "图片"}
				</span>
				<button className={btn} disabled={!!busy || loading || !!err} onClick={() => void captureCurrent()}
					title="把当前视角导出为图片，在画布落一个新图片节点（1600×900）">
					{busy === "当前视角" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Camera className="h-3.5 w-3.5" />}
					<span>截取当前视角</span>
				</button>
				{(["four", "six", "eight", "twelve"] as const).map((k) => (
					<button key={k} className={btn} disabled={!!busy || loading || !!err} onClick={() => void captureSet(k)}
						title={{
							four: "前/右/后/左 四个方向（fov90），落为分镜组节点",
							six: "四视图 + 上/下（fov90），落为分镜组节点",
							eight: "水平每45°共八向（fov60），落为分镜组节点",
							twelve: "平视/俯45/仰45 三层×前右后左（fov60），落为分镜组节点",
						}[k]}>
						{busy === VIEW_SET_LABELS[k] ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
						<span>{VIEW_SET_LABELS[k]}</span>
					</button>
				))}
				<button className={btn} disabled={loading || !!err}
					title="3D模型：在全景空间里放置 可动人偶/道具/GLB 模型（真三维——转视角透视跟随），可截取带模型的视角、导出姿势图/深度图"
					onClick={() => {
						const node = session.sourceNodeId ? useCanvasStore.getState().nodes[session.sourceNodeId] : null;
						openDirectorStage({
							mode: "pano",
							uri: session.uri,
							fallbackUri: session.fallbackUri,
							name: session.name,
							sourceNodeId: session.sourceNodeId,
							srcAssetId: node?.data.resultAssetId ?? undefined,
							scene: node?.data.stage3d?.scene,
						});
						close();
					}}>
					<Bone className="h-3.5 w-3.5" /><span>3D模型</span>
				</button>
				<div style={{ flex: 1 }} />
				<span style={{ fontSize: 11.5, color: "rgba(255,255,255,0.4)" }}>拖动=转视角 · 滚轮=视场缩放</span>
				<button className={btn} onClick={close} title="关闭（Esc）"><X className="h-3.5 w-3.5" /><span>关闭</span></button>
			</div>

			{/* 查看画布 */}
			<div style={{ flex: 1, minHeight: 0, position: "relative" }}>
				{err ? (
					<div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#fca5a5", fontSize: 13 }}>{err}</div>
				) : (
					<>
						{loading && (
							<div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "rgba(255,255,255,0.6)", fontSize: 13, gap: 8 }}>
								<Loader2 className="h-4 w-4 animate-spin" /> 载入全景…
							</div>
						)}
						<canvas ref={canvasRef} onMouseDown={beginDrag}
							style={{ width: "100%", height: "100%", display: "block", cursor: dragging ? "grabbing" : "grab" }} />
						{/* 姿态 HUD */}
						<div style={{ position: "absolute", right: 14, bottom: 14, padding: "6px 10px", borderRadius: 8, background: "rgba(10,13,20,0.75)", border: "1px solid rgba(255,255,255,0.12)", fontSize: 12, fontFamily: "monospace", color: "rgba(255,255,255,0.85)", pointerEvents: "none" }}>
							横 {hud.yaw}° · 纵 {hud.pitch}°<br />视场 {hud.fov}°
						</div>
					</>
				)}
			</div>
		</div>
	);
}
