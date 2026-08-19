/**
 * PanoNodeView —— 720全景查看节点（pano.view）的节点体渲染（第195轮）。
 *
 * 吃上游第一条图片连线的 equirect 全景图，**节点上直接 WebGL 交互查看**（跳过扭曲平面图）：
 * 拖动=转视角、滚轮=视场缩放、双击=放大到全屏查看器（截取当前视角/四/六/八/十二视图在那边）。
 * ⚠ canvas 挂 nodrag/nowheel（xyflow 语义：不拖节点/不缩画布）；
 * ⚠ 字节 fetch→createImageBitmap + /raw 兜底（涂鸦同款教训）；卸载/换图 destroy 渲染器
 *   （WebView2 WebGL context 有数量上限）。
 */
import { useEffect, useRef, useState } from "react";
import { Globe, Loader2 } from "lucide-react";
import { useCanvasStore } from "@/store/canvasStore";
import { useLibraryStore } from "@/store/libraryStore";
import { useConnectionStore } from "@/store/connectionStore";
import { PanoRenderer } from "@/lib/panoRender";
import { normYaw } from "@/lib/panoView";
import { fetchUriOf } from "@/canvas/annotate";
import { openPanoViewer } from "@/store/panoStore";

export function PanoNodeView({ nodeId }: { nodeId: string }) {
	// 上游第一条图片连线的结果资产（生成完成自动出现→本节点自动转全景显示）
	const upAssetId = useCanvasStore((s) => {
		for (const e of Object.values(s.edges)) {
			if (e.target !== nodeId) continue;
			const up = s.nodes[e.source];
			const aid = up?.data.resultAssetId;
			if (aid) return aid;
		}
		return null;
	});
	const upName = useLibraryStore((s) => (upAssetId ? s.assets[upAssetId]?.name ?? null : null));

	const canvasRef = useRef<HTMLCanvasElement>(null);
	const rendererRef = useRef<PanoRenderer | null>(null);
	const viewRef = useRef({ yaw: 0, pitch: 0, fov: 60 });
	const [hud, setHud] = useState({ yaw: 0, pitch: 0, fov: 60 });
	const [state, setState] = useState<"empty" | "loading" | "ready" | "error">("empty");
	const [dragging, setDragging] = useState(false);

	const draw = () => {
		const r = rendererRef.current;
		const canvas = canvasRef.current;
		if (!r || !canvas) return;
		const dpr = Math.min(2, window.devicePixelRatio || 1);
		const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
		const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
		if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
		const v = viewRef.current;
		r.render(v.yaw, v.pitch, v.fov);
		setHud({ yaw: Math.round(normYaw(v.yaw)), pitch: Math.round(v.pitch), fov: Math.round(v.fov) });
	};

	// ── 载图（上游资产变化即重载；卸载/换图释放 WebGL） ──
	useEffect(() => {
		if (!upAssetId) { setState("empty"); return; }
		setState("loading");
		let alive = true;
		(async () => {
			const asset = useLibraryStore.getState().assets[upAssetId];
			const base = useConnectionStore.getState().normalizedUrl();
			const sid = asset?.serverAssetId || upAssetId;
			const uris = [
				fetchUriOf(upAssetId),
				base && sid && !sid.startsWith("LC-") ? `${base}/v1/assets/${sid}/raw` : "",
			].filter(Boolean);
			let bmp: ImageBitmap | null = null;
			for (const uri of uris) {
				try {
					const resp = await fetch(uri);
					if (!resp.ok) throw new Error();
					bmp = await createImageBitmap(await resp.blob());
					break;
				} catch { /* 试下一个源 */ }
			}
			if (!alive) return;
			if (!bmp) { setState("error"); return; }
			try {
				rendererRef.current?.destroy();
				const r = new PanoRenderer(canvasRef.current!);
				r.setImage(bmp);
				rendererRef.current = r;
				viewRef.current = { yaw: 0, pitch: 0, fov: 60 };
				setState("ready");
				// ⚠ 首帧不用 rAF（后台标签 rAF 冻结=黑屏，实测）：setTimeout(0) 等布局完成后直接画
				setTimeout(draw, 0);
			} catch {
				setState("error");
			}
		})();
		return () => {
			alive = false;
			rendererRef.current?.destroy();
			rendererRef.current = null;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [upAssetId]);

	// 滚轮=视场（native 非 passive；nowheel 已挡画布缩放，这里挡页面滚动）
	useEffect(() => {
		const el = canvasRef.current;
		if (!el || state !== "ready") return;
		const onWheel = (e: WheelEvent) => {
			e.preventDefault();
			e.stopPropagation();
			const v = viewRef.current;
			v.fov = Math.max(25, Math.min(110, v.fov * Math.exp(e.deltaY * 0.001)));
			draw();
		};
		el.addEventListener("wheel", onWheel, { passive: false });
		return () => el.removeEventListener("wheel", onWheel);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [state]);

	const beginDrag = (e: React.MouseEvent) => {
		if (e.button !== 0 || state !== "ready") return;
		e.preventDefault();
		e.stopPropagation();
		setDragging(true);
		const start = { x: e.clientX, y: e.clientY, yaw: viewRef.current.yaw, pitch: viewRef.current.pitch };
		const onMove = (me: MouseEvent) => {
			const v = viewRef.current;
			const k = 0.22 * (v.fov / 60);
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

	/** 双击=放大到全屏查看器（截取功能在那边；产物落本节点右侧） */
	const openFull = () => {
		if (!upAssetId) return;
		const asset = useLibraryStore.getState().assets[upAssetId];
		const base = useConnectionStore.getState().normalizedUrl();
		const sid = asset?.serverAssetId || upAssetId;
		openPanoViewer({
			uri: fetchUriOf(upAssetId),
			fallbackUri: base && sid && !sid.startsWith("LC-") ? `${base}/v1/assets/${sid}/raw` : undefined,
			name: asset?.name || undefined,
			sourceNodeId: nodeId,
		});
	};

	if (!upAssetId || state === "empty") {
		return (
			<div className="flex h-full w-full flex-col items-center justify-center gap-2 text-[10px] text-muted-foreground p-3 text-center">
				<Globe className="h-5 w-5 opacity-60" />
				<span>连接一张 equirect 2:1 全景图（上游生成完成后自动进入全景查看）</span>
			</div>
		);
	}
	return (
		<div className="relative h-full w-full nodrag nowheel" style={{ borderRadius: 8, overflow: "hidden" }}>
			{state === "loading" && (
				<div className="absolute inset-0 z-10 flex items-center justify-center gap-2 text-[10px] text-muted-foreground bg-black/30">
					<Loader2 className="h-3.5 w-3.5 animate-spin" /> 载入全景…
				</div>
			)}
			{state === "error" && (
				<div className="absolute inset-0 z-10 flex items-center justify-center text-[10px] text-red-300 bg-black/30">全景图加载失败</div>
			)}
			<canvas ref={canvasRef} onMouseDown={beginDrag}
				onDoubleClick={(e) => { e.stopPropagation(); openFull(); }}
				style={{ width: "100%", height: "100%", display: "block", cursor: dragging ? "grabbing" : "grab" }} />
			{/* 角标：720 标识 + 姿态 HUD */}
			<div style={{ position: "absolute", left: 6, top: 6, padding: "1px 6px", borderRadius: 5, background: "rgba(10,13,20,0.7)", fontSize: 9, color: "rgba(255,255,255,0.8)", pointerEvents: "none" }}>
				720° · {upName || "全景"}
			</div>
			<div style={{ position: "absolute", right: 6, bottom: 6, padding: "2px 6px", borderRadius: 5, background: "rgba(10,13,20,0.7)", fontSize: 9, fontFamily: "monospace", color: "rgba(255,255,255,0.8)", pointerEvents: "none" }}>
				横{hud.yaw}° 纵{hud.pitch}° 场{hud.fov}°
			</div>
			<div style={{ position: "absolute", right: 6, top: 6, padding: "1px 6px", borderRadius: 5, background: "rgba(10,13,20,0.7)", fontSize: 9, color: "rgba(255,255,255,0.6)", pointerEvents: "none" }}>
				拖动查看 · 双击放大
			</div>
		</div>
	);
}
