/**
 * DirectorStageModal —— 3D 导演台（可嵌入模型舞台）弹窗（App 根 lazy，store 会话门控）。
 *
 * 三宿主一套 UI：独立舞台（网格）/ 图片垫底（涂鸦嵌入同此，embed 回调交回）/ 720°全景。
 * 渲染引擎在 src/lib/modelStage.ts（three，**本组件内动态 import**——不进主包）；
 * 交互：空白拖=转相机（全景=转视角）、Shift/右键拖=平移、滚轮=距离（全景=视场）、
 * 点模型=选中、拖模型=水平移动（Shift=垂直）、姿势模式下拖关节=摆姿势。
 * ⚠ 首绘/mutation 后显式 render（勿依赖 rAF——后台标签冻结，第195轮教训）。
 */
import { useEffect, useRef, useState } from "react";
import {
	Box, Bone, Globe, Loader2, PersonStanding, Plus, Trash2, Upload, X,
} from "lucide-react";
import { useDirectorStore, type DirectorSession } from "@/store/directorStore";
import { useLibraryStore } from "@/store/libraryStore";
import { uploadMediaToCanvasAsset } from "@/canvas/nodeUpload";
import { fetchUriOf } from "@/canvas/annotate";
import { saveStageOutputs } from "@/canvas/directorOp";
import { genId } from "@/lib/id";
import { PROP_SHAPES, type PropShape, type StageModel } from "@/lib/stageScene";
import type { ModelStage } from "@/lib/modelStage";

const Z = 100400; // 高于全景查看器(100270)与涂鸦编辑器(100300 根/100320 面板)——两处都能唤起本弹窗

type DragState =
	| { kind: "orbit" | "pan"; x: number; y: number }
	| { kind: "model"; id: string; anchorY: number; offX: number; offZ: number; vertical: boolean; baseY: number; startY: number }
	| { kind: "joint"; id: string; joint: string }
	| {
		// 选中框拉边缩放（第207轮）：等比=按指针到框中心距离比；非等比=边的两个固定世界轴各按位移比拉伸
		kind: "scale";
		id: string;
		axis: 0 | 1 | 2;
		center: [number, number, number];
		p0: [number, number, number];
		baseScale: number;
		baseStretch: [number, number, number];
		uniform: boolean;
	};

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const normDeg = (v: number): number => ((((v + 180) % 360) + 360) % 360) - 180;

export default function DirectorStageModal() {
	const session = useDirectorStore((s) => s.session);
	if (!session) return null;
	return <DirectorStage key={session.sourceNodeId || session.uri || "blank"} session={session} />;
}

function DirectorStage({ session }: { session: DirectorSession }) {
	const close = () => useDirectorStore.getState().close();
	const wrapRef = useRef<HTMLDivElement>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const stageRef = useRef<ModelStage | null>(null);
	const glbBytesRef = useRef(new Map<string, ArrayBuffer>());
	const dragRef = useRef<DragState | null>(null);
	const imgSizeRef = useRef<{ w: number; h: number } | null>(null);

	const [ready, setReady] = useState(false);
	const [err, setErr] = useState("");
	const [models, setModels] = useState<StageModel[]>([]);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [poseMode, setPoseMode] = useState(false);
	const [propOpen, setPropOpen] = useState(false);
	const [busy, setBusy] = useState("");
	const [outComposite, setOutComposite] = useState(true);
	const [outPose, setOutPose] = useState(true);
	const [outDepth, setOutDepth] = useState(true);
	/** 拉边缩放的等比开关（属性栏；开=拖任意边整体缩放，关=按边的轴向分轴拉伸） */
	const [uniformScale, setUniformScale] = useState(true);
	/** 场景透视开关（第208轮；关=正交平行投影。pano 宿主恒透视不显示） */
	const [ortho, setOrtho] = useState(false);

	const glbResolver = async (assetId: string): Promise<ArrayBuffer | null> => {
		const hit = glbBytesRef.current.get(assetId);
		if (hit) return hit;
		try {
			const uri = fetchUriOf(assetId);
			if (!uri) return null;
			const bytes = await (await fetch(uri)).arrayBuffer();
			glbBytesRef.current.set(assetId, bytes);
			return bytes;
		} catch {
			return null;
		}
	};

	/* 初始化：底图位图 → 建 stage → 载入初始场景 */
	useEffect(() => {
		let dead = false;
		let stage: ModelStage | null = null;
		(async () => {
			try {
				let bitmap: ImageBitmap | null = null;
				if (session.mode !== "stage" && session.uri) {
					bitmap = await loadBitmap(session.uri, session.fallbackUri);
					if (bitmap) imgSizeRef.current = { w: bitmap.width, h: bitmap.height };
				}
				if (dead) return;
				if (session.mode !== "stage" && !bitmap) throw new Error("底图加载失败");
				const mod = await import("@/lib/modelStage");
				if (dead || !canvasRef.current) return;
				stage = new mod.ModelStage(
					canvasRef.current,
					session.mode === "stage" ? { mode: "stage" } : { mode: session.mode, bitmap: bitmap! },
				);
				stageRef.current = stage;
				stage.onChange = () => {
					setModels(stage!.listModels().map((m) => ({ ...m })));
					setSelectedId(stage!.selectedId);
					stage!.render();
				};
				if (session.camera) stage.setCameraState(session.camera);
				setOrtho(stage.projection === "ortho"); // 再编辑还原投影模式
				if (session.scene) await stage.setSceneDoc(session.scene, glbResolver);
				fitCanvas();
				setReady(true);
				// ⚠ 首绘不用 rAF（后台标签冻结）
				setTimeout(() => stage?.render(), 0);
			} catch (e) {
				if (!dead) setErr(e instanceof Error ? e.message : "3D 舞台初始化失败");
			}
		})();
		const onResize = () => fitCanvas();
		window.addEventListener("resize", onResize);
		return () => {
			dead = true;
			window.removeEventListener("resize", onResize);
			stage?.destroy();
			stageRef.current = null;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const fitCanvas = () => {
		const stage = stageRef.current;
		const wrap = wrapRef.current;
		if (!stage || !wrap) return;
		stage.setSize(wrap.clientWidth, wrap.clientHeight);
		stage.render();
	};

	/* 滚轮：native 非 passive。指针悬在选中框某条边上=绕该边轴向旋转模型（第207轮）；否则 距离/视场 */
	useEffect(() => {
		const cv = canvasRef.current;
		if (!cv) return;
		const onWheel = (e: WheelEvent) => {
			e.preventDefault();
			const stage = stageRef.current;
			if (!stage) return;
			const rect = cv.getBoundingClientRect();
			const ep = stage.selectedId ? stage.edgePick(e.clientX - rect.left, e.clientY - rect.top) : null;
			if (ep && stage.selectedId) {
				const m = stage.getModel(stage.selectedId);
				if (m) {
					// 边平行于哪个轴，就绕模型对应本地轴转（5°/格；属性栏三轴旋转参数同步跟随）
					const la = stage.worldAxisToLocalAxis(stage.selectedId, ep.axis);
					const rot = [...m.rot] as [number, number, number];
					rot[la] = normDeg(rot[la] + (e.deltaY > 0 ? -5 : 5));
					stage.updateModel(stage.selectedId, { rot });
					stage.render();
					return;
				}
			}
			stage.dollyBy(e.deltaY > 0 ? 1.1 : 1 / 1.1);
			stage.render();
		};
		cv.addEventListener("wheel", onWheel, { passive: false });
		return () => cv.removeEventListener("wheel", onWheel);
	}, [ready]);

	/* 指针交互 */
	const onPointerDown = (e: React.PointerEvent) => {
		const stage = stageRef.current;
		const cv = canvasRef.current;
		if (!stage || !cv) return;
		e.preventDefault();
		const rect = cv.getBoundingClientRect();
		const px = e.clientX - rect.left;
		const py = e.clientY - rect.top;
		const hit = stage.pick(px, py);
		// 选中框拉边=缩放（关节命中优先；边命中优先于模型本体——边多在模型轮廓外）
		const ep = hit?.type !== "joint" && stage.selectedId ? stage.edgePick(px, py) : null;
		if (hit?.type === "joint" && hit.jointName) {
			dragRef.current = { kind: "joint", id: hit.modelId, joint: hit.jointName };
		} else if (ep && stage.selectedId) {
			const m = stage.getModel(stage.selectedId)!;
			const p0 = stage.rayOnViewPlanePoint(px, py, ep.center);
			if (p0) {
				dragRef.current = {
					kind: "scale", id: stage.selectedId, axis: ep.axis, center: ep.center, p0,
					baseScale: m.scale, baseStretch: [...(m.stretch ?? [1, 1, 1])] as [number, number, number],
					uniform: uniformScale,
				};
			}
		} else if (hit?.type === "model") {
			stage.setSelected(hit.modelId);
			const m = stage.getModel(hit.modelId)!;
			const ground = stage.rayOnHorizontal(px, py, m.pos[1]);
			dragRef.current = {
				kind: "model",
				id: hit.modelId,
				anchorY: m.pos[1],
				offX: ground ? m.pos[0] - ground.x : 0,
				offZ: ground ? m.pos[2] - ground.z : 0,
				vertical: e.shiftKey,
				baseY: m.pos[1],
				startY: e.clientY,
			};
		} else {
			if (stage.selectedId && !e.shiftKey && e.button === 0) stage.setSelected(null);
			dragRef.current = { kind: e.shiftKey || e.button === 2 ? "pan" : "orbit", x: e.clientX, y: e.clientY };
		}
		const onMove = (me: PointerEvent) => {
			const d = dragRef.current;
			const st = stageRef.current;
			if (!d || !st) return;
			const r = cv.getBoundingClientRect();
			const mx = me.clientX - r.left;
			const my = me.clientY - r.top;
			if (d.kind === "orbit") {
				st.orbitBy(me.clientX - d.x, me.clientY - d.y);
				d.x = me.clientX; d.y = me.clientY;
			} else if (d.kind === "pan") {
				st.panBy(me.clientX - d.x, me.clientY - d.y);
				d.x = me.clientX; d.y = me.clientY;
			} else if (d.kind === "model") {
				const m = st.getModel(d.id);
				if (!m) return;
				if (d.vertical || me.shiftKey) {
					const ny = d.baseY + (d.startY - me.clientY) * 0.01;
					st.updateModel(d.id, { pos: [m.pos[0], ny, m.pos[2]] });
				} else {
					const g = st.rayOnHorizontal(mx, my, d.anchorY);
					if (g) st.updateModel(d.id, { pos: [g.x + d.offX, d.anchorY, g.z + d.offZ] });
				}
			} else if (d.kind === "scale") {
				const p1 = st.rayOnViewPlanePoint(mx, my, d.center);
				if (!p1) return;
				const v0 = [d.p0[0] - d.center[0], d.p0[1] - d.center[1], d.p0[2] - d.center[2]];
				const v1 = [p1[0] - d.center[0], p1[1] - d.center[1], p1[2] - d.center[2]];
				if (d.uniform) {
					// 等比：指针到框中心的距离比 = 整体缩放比
					const l0 = Math.hypot(v0[0], v0[1], v0[2]);
					const l1 = Math.hypot(v1[0], v1[1], v1[2]);
					if (l0 > 1e-4) st.updateModel(d.id, { scale: clamp(d.baseScale * (l1 / l0), 0.05, 20) });
				} else {
					// 分轴：边的两个固定世界轴各按位移分量比拉伸（拖哪个方向哪个方向变）
					const stretch = [...d.baseStretch] as [number, number, number];
					for (const a of [0, 1, 2] as const) {
						if (a === d.axis) continue;
						if (Math.abs(v0[a]) < 1e-3) continue;
						const la = st.worldAxisToLocalAxis(d.id, a);
						stretch[la] = clamp(d.baseStretch[la] * Math.abs(v1[a]) / Math.abs(v0[a]), 0.05, 20);
					}
					st.updateModel(d.id, { stretch });
				}
			} else if (d.kind === "joint") {
				const anchor = st.jointWorldPos(d.id, d.joint);
				if (!anchor) return;
				const target = st.rayOnViewPlane(mx, my, anchor);
				if (target) st.dragJointTo(d.id, d.joint, target);
			}
			st.render();
		};
		const onUp = () => {
			dragRef.current = null;
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
	};

	/* 悬停提示：指针悬在选中框边上 → 十字光标（提示可 拖边缩放 / 滚轮旋转） */
	const onCanvasHover = (e: React.PointerEvent) => {
		if (dragRef.current) return;
		const stage = stageRef.current;
		const cv = canvasRef.current;
		if (!stage || !cv) return;
		const rect = cv.getBoundingClientRect();
		const ep = stage.selectedId ? stage.edgePick(e.clientX - rect.left, e.clientY - rect.top) : null;
		cv.style.cursor = ep ? "crosshair" : "grab";
	};

	/* 加模型 */
	const lastModelId = (): string | null => {
		const l = stageRef.current?.listModels() ?? [];
		return l.length ? l[l.length - 1].id : null;
	};
	const spawnPos = (): [number, number, number] => {
		const stage = stageRef.current;
		if (!stage) return [0, 0, 0];
		if (session.mode === "pano") {
			const yaw = (stage.pano.yaw * Math.PI) / 180;
			return [Math.sin(yaw) * 2.6, -0.6, Math.cos(yaw) * 2.6];
		}
		const t = stage.getCameraState().target;
		return [t[0], 0, t[2]];
	};
	const addFigure = () => {
		const p = spawnPos();
		void stageRef.current?.addModel({
			id: genId("m"), kind: "figure", pos: [p[0], p[1], p[2]], rot: [0, 0, 0], scale: 1, pose: {},
			name: `人偶${models.filter((m) => m.kind === "figure").length + 1}`,
		}).then((ok) => { if (ok) stageRef.current?.setSelected(lastModelId()); });
	};
	const addProp = (shape: PropShape) => {
		setPropOpen(false);
		const p = spawnPos();
		const label = PROP_SHAPES.find((s) => s.shape === shape)?.label || shape;
		void stageRef.current?.addModel({
			id: genId("m"), kind: "prop", shape, pos: [p[0], p[1] + 0.5, p[2]], rot: [0, 0, 0], scale: 1,
			name: `${label}${models.filter((m) => m.kind === "prop").length + 1}`,
		}).then((ok) => { if (ok) stageRef.current?.setSelected(lastModelId()); });
	};
	const importGlb = async (file: File) => {
		setBusy("导入模型…");
		try {
			const bytes = await file.arrayBuffer();
			const up = await uploadMediaToCanvasAsset(file, "TP"); // 懒上传：字节本地暂存
			glbBytesRef.current.set(up.assetId, bytes);
			useLibraryStore.getState().addAsset({
				id: up.assetId, kind: "image", name: file.name, uri: up.displayUri, serverAssetId: null,
				thumbnailUri: null, createdAt: new Date().toISOString(), deletedByUser: false, localPath: up.localPath,
			});
			const p = spawnPos();
			const ok = await stageRef.current?.addModel(
				{ id: genId("m"), kind: "glb", assetId: up.assetId, srcName: file.name, pos: p, rot: [0, 0, 0], scale: 1, name: file.name.replace(/\.[a-z0-9]+$/i, "") },
				glbResolver,
			);
			if (!ok) setErr("模型解析失败（仅支持 glb/gltf）");
			else stageRef.current?.setSelected(lastModelId());
		} catch (e2) {
			setErr(e2 instanceof Error ? e2.message : "模型导入失败");
		} finally {
			setBusy("");
		}
	};

	/* 产物 */
	const outputSize = (): { w: number; h: number } => {
		if (session.mode === "image" && imgSizeRef.current) {
			const { w, h } = imgSizeRef.current;
			const cap = 2048 / Math.max(w, h);
			return cap < 1 ? { w: Math.round(w * cap), h: Math.round(h * cap) } : { w, h };
		}
		if (session.mode === "pano") return { w: 1600, h: 900 };
		return { w: 1280, h: 720 };
	};
	const saveOutputs = async () => {
		const stage = stageRef.current;
		if (!stage) return;
		const { w, h } = outputSize();
		setBusy("渲染产物…");
		try {
			if (session.embed) {
				const blob = await stage.captureComposite(session.embed.width, session.embed.height, true);
				session.embed.onDone({ blob, scene: stage.getSceneDoc(), camera: stage.getCameraState() });
				close();
				return;
			}
			const items: { blob: Blob; label: string; withScene?: boolean }[] = [];
			if (outComposite) items.push({ blob: await stage.captureComposite(w, h), label: "合成图", withScene: true });
			if (outPose && hasFigure) items.push({ blob: await stage.capturePose(w, h), label: "姿势图" });
			if (outDepth) items.push({ blob: await stage.captureDepth(w, h), label: "深度图" });
			if (!items.length) { setErr("请至少勾选一种产物"); return; }
			const e = await saveStageOutputs(items, {
				sourceNodeId: session.sourceNodeId,
				baseName: session.name?.replace(/\.[a-z0-9]+$/i, "") || "3D舞台",
				scene: stage.getSceneDoc(),
				mode: session.mode,
				srcAssetId: session.srcAssetId,
			});
			if (e) setErr(e);
			else close();
		} catch (e2) {
			setErr(e2 instanceof Error ? e2.message : "产物渲染失败");
		} finally {
			setBusy("");
		}
	};

	const sel = selectedId ? models.find((m) => m.id === selectedId) ?? null : null;
	const hasFigure = models.some((m) => m.kind === "figure");
	const patchSel = (patch: Parameters<ModelStage["updateModel"]>[1]) => {
		if (selectedId) { stageRef.current?.updateModel(selectedId, patch); stageRef.current?.render(); }
	};

	const btn = (active = false): React.CSSProperties => ({
		display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 8,
		border: `1px solid ${active ? "rgba(34,211,238,0.7)" : "rgba(255,255,255,0.14)"}`,
		background: active ? "rgba(34,211,238,0.16)" : "rgba(255,255,255,0.06)",
		color: active ? "#7de6f4" : "#dfe4ee", fontSize: 13, cursor: "pointer",
	});

	return (
		<div style={{ position: "fixed", inset: 0, zIndex: Z, background: "rgba(5,7,12,0.92)", display: "flex", flexDirection: "column" }}>
			{/* 顶栏 */}
			<div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 16px", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
				<Bone size={17} color="#7de6f4" />
				<span style={{ color: "#eef1f7", fontWeight: 600, fontSize: 15 }}>
					3D 导演台{session.name ? ` · ${session.name}` : ""}
					{session.mode === "pano" ? " · 全景" : session.mode === "image" ? " · 垫底图" : ""}
				</span>
				<span style={{ color: "#8a93a6", fontSize: 12 }}>
					拖动=转{session.mode === "pano" ? "视角" : "相机"} · Shift/右键=平移 · 滚轮={session.mode === "pano" ? "视场" : "距离"} · 拖模型=移动（Shift=升降）· 选中框：拖边=缩放 · 边上滚轮=旋转
				</span>
				<div style={{ flex: 1 }} />
				{err && <span style={{ color: "#ff8f8f", fontSize: 12, maxWidth: 340, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={err}>{err}</span>}
				{busy && <span style={{ color: "#7de6f4", fontSize: 12, display: "inline-flex", alignItems: "center", gap: 6 }}><Loader2 size={13} className="animate-spin" />{busy}</span>}
				<button style={btn()} onClick={close}><X size={14} />关闭</button>
			</div>

			<div style={{ flex: 1, display: "flex", minHeight: 0 }}>
				{/* 视口 */}
				<div ref={wrapRef} style={{ flex: 1, position: "relative", minWidth: 0 }}>
					<canvas
						ref={canvasRef}
						onPointerDown={onPointerDown}
						onPointerMove={onCanvasHover}
						onContextMenu={(e) => e.preventDefault()}
						style={{ position: "absolute", inset: 0, width: "100%", height: "100%", touchAction: "none", cursor: "grab" }}
					/>
					{!ready && !err && (
						<div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#8a93a6", fontSize: 13 }}>
							<Loader2 size={15} className="animate-spin" style={{ marginRight: 8 }} />3D 舞台加载中…
						</div>
					)}
					{session.mode === "pano" && ready && (
						<div style={{ position: "absolute", left: 12, bottom: 10, color: "#9aa3b5", fontSize: 11, display: "flex", alignItems: "center", gap: 5 }}>
							<Globe size={12} />横 {Math.round((((stageRef.current?.pano.yaw ?? 0) % 360) + 360) % 360)}° · 纵 {Math.round(stageRef.current?.pano.pitch ?? 0)}° · 场 {Math.round(stageRef.current?.pano.fov ?? 75)}°
						</div>
					)}
				</div>

				{/* 右栏：添加/工具（第207轮从顶部工具栏迁入）+ 模型列表 + 选中属性 */}
				<div style={{ width: 262, borderLeft: "1px solid rgba(255,255,255,0.08)", padding: 12, overflowY: "auto", display: "flex", flexDirection: "column", gap: 10 }}>
					{session.mode !== "pano" && (
						<>
							<div style={{ color: "#9aa3b5", fontSize: 12 }}>视图</div>
							<label style={{ display: "flex", alignItems: "center", gap: 6, color: "#c6ccd9", fontSize: 12, cursor: "pointer" }}
								title="开=透视投影（近大远小，默认）；关=正交平行投影（无透视收缩，摆位/对齐更直观）。切换不改变相机机位，产物按当前投影渲染">
								<input type="checkbox" checked={!ortho} disabled={!ready}
									onChange={(e) => {
										const persp = e.target.checked;
										setOrtho(!persp);
										stageRef.current?.setProjection(persp ? "persp" : "ortho");
										stageRef.current?.render();
									}} />
								场景透视（关=正交平行投影）
							</label>
						</>
					)}
					<div style={{ color: "#9aa3b5", fontSize: 12, ...(session.mode !== "pano" ? { borderTop: "1px solid rgba(255,255,255,0.08)", paddingTop: 10 } : {}) }}>添加模型</div>
					<div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
						<button style={btn()} onClick={addFigure} disabled={!ready}><PersonStanding size={14} />加人偶</button>
						<button style={btn(propOpen)} onClick={() => setPropOpen((v) => !v)} disabled={!ready}><Box size={14} />加道具</button>
						<label style={{ ...btn(), position: "relative" }}>
							<Upload size={14} />导入GLB
							<input type="file" accept=".glb,.gltf" style={{ position: "absolute", inset: 0, opacity: 0, cursor: "pointer" }}
								onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void importGlb(f); }} />
						</label>
					</div>
					{propOpen && (
						<div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: 6, background: "#151a24", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 8 }}>
							{PROP_SHAPES.map((s) => (
								<button key={s.shape} style={btn()} onClick={() => addProp(s.shape)}>{s.label}</button>
							))}
						</div>
					)}
					<div style={{ color: "#9aa3b5", fontSize: 12, borderTop: "1px solid rgba(255,255,255,0.08)", paddingTop: 10 }}>模型（{models.length}）</div>
					{models.length === 0 && <div style={{ color: "#6b7385", fontSize: 12 }}>点上方「加人偶/加道具/导入GLB」放入模型</div>}
					{models.map((m) => (
						<button key={m.id} style={{ ...btn(m.id === selectedId), justifyContent: "flex-start" }} onClick={() => { stageRef.current?.setSelected(m.id); }}>
							{m.kind === "figure" ? <PersonStanding size={13} /> : m.kind === "prop" ? <Box size={13} /> : <Upload size={13} />}
							<span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.name || m.id}</span>
						</button>
					))}
					{sel && (
						<div style={{ borderTop: "1px solid rgba(255,255,255,0.08)", paddingTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
							<div style={{ color: "#9aa3b5", fontSize: 12 }}>选中：{sel.name || sel.id}</div>
							<SliderRow label="朝向" min={-180} max={180} step={5} value={sel.rot[1]} onChange={(v) => patchSel({ rot: [sel.rot[0], v, sel.rot[2]] })} suffix="°" />
							<SliderRow label="俯仰" min={-180} max={180} step={5} value={sel.rot[0]} onChange={(v) => patchSel({ rot: [v, sel.rot[1], sel.rot[2]] })} suffix="°" />
							<SliderRow label="侧倾" min={-180} max={180} step={5} value={sel.rot[2]} onChange={(v) => patchSel({ rot: [sel.rot[0], sel.rot[1], v] })} suffix="°" />
							<SliderRow label="缩放" min={0.2} max={4} step={0.05} value={sel.scale} onChange={(v) => patchSel({ scale: v })} suffix="×" />
							<label style={{ display: "flex", alignItems: "center", gap: 6, color: "#c6ccd9", fontSize: 12, cursor: "pointer" }} title="开=拖选中框任意边整体缩放；关=按边的轴向分轴拉伸（变形）">
								<input type="checkbox" checked={uniformScale} onChange={(e) => setUniformScale(e.target.checked)} />
								等比缩放（拉边时）
							</label>
							{sel.stretch && (
								<div style={{ display: "flex", alignItems: "center", gap: 8, color: "#c6ccd9", fontSize: 12 }}>
									<span>拉伸 {sel.stretch.map((n) => Math.round(n * 100) / 100).join(" / ")}</span>
									<button style={{ ...btn(), padding: "2px 8px", fontSize: 12 }} onClick={() => patchSel({ stretch: [1, 1, 1] })}>重置</button>
								</div>
							)}
							<SliderRow label="高度" min={-2} max={3} step={0.05} value={sel.pos[1]} onChange={(v) => patchSel({ pos: [sel.pos[0], v, sel.pos[2]] })} suffix="m" />
							{sel.kind !== "glb" && (
								<label style={{ display: "flex", alignItems: "center", gap: 8, color: "#c6ccd9", fontSize: 12 }}>
									颜色
									<input type="color" value={(sel as { color?: string }).color || (sel.kind === "figure" ? "#c8ccd8" : "#8fa3c8")}
										onChange={(e) => patchSel({ color: e.target.value })} />
								</label>
							)}
							{sel.kind === "figure" && (
								<div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
									<button
										style={btn(poseMode)}
										onClick={() => { const on = !poseMode; setPoseMode(on); stageRef.current?.setPoseMode(on); stageRef.current?.render(); }}
										title="开启后拖动青色关节点摆姿势"
									>
										<PersonStanding size={14} />姿势模式
									</button>
									<button style={btn()} onClick={() => patchSel({ pose: {} })}>重置姿势</button>
								</div>
							)}
							<button style={btn()} onClick={() => { stageRef.current?.removeModel(sel.id); }}><Trash2 size={14} />删除选中</button>
						</div>
					)}
				</div>
			</div>

			{/* 底栏：产物 */}
			<div style={{ display: "flex", alignItems: "center", gap: 14, padding: "10px 16px", borderTop: "1px solid rgba(255,255,255,0.08)" }}>
				{session.embed ? (
					<>
						<span style={{ color: "#8a93a6", fontSize: 12 }}>完成后模型层将嵌回涂鸦画面（可继续变形/擦除；再点 3D模型 可重新编辑）</span>
						<div style={{ flex: 1 }} />
						<button style={{ ...btn(true), padding: "8px 18px" }} onClick={() => void saveOutputs()} disabled={!ready || !!busy || models.length === 0}>
							<Plus size={14} />嵌入画面
						</button>
					</>
				) : (
					<>
						<span style={{ color: "#9aa3b5", fontSize: 12 }}>保存产物：</span>
						<CheckRow label="合成图" checked={outComposite} onChange={setOutComposite} />
						<CheckRow label={`姿势图${hasFigure ? "" : "（需人偶）"}`} checked={outPose && hasFigure} disabled={!hasFigure} onChange={setOutPose} />
						<CheckRow label="深度图" checked={outDepth} onChange={setOutDepth} />
						<div style={{ flex: 1 }} />
						<button style={{ ...btn(true), padding: "8px 18px" }} onClick={() => void saveOutputs()} disabled={!ready || !!busy || models.length === 0}>
							<Plus size={14} />保存到画布
						</button>
					</>
				)}
			</div>
		</div>
	);
}

function SliderRow(props: { label: string; min: number; max: number; step: number; value: number; suffix?: string; onChange: (v: number) => void }) {
	return (
		<label style={{ display: "flex", alignItems: "center", gap: 8, color: "#c6ccd9", fontSize: 12 }}>
			<span style={{ width: 30 }}>{props.label}</span>
			<input type="range" min={props.min} max={props.max} step={props.step} value={props.value}
				style={{ flex: 1 }} onChange={(e) => props.onChange(Number(e.target.value))} />
			<span style={{ width: 44, textAlign: "right", color: "#8a93a6" }}>{Math.round(props.value * 100) / 100}{props.suffix}</span>
		</label>
	);
}

function CheckRow(props: { label: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
	return (
		<label style={{ display: "inline-flex", alignItems: "center", gap: 6, color: props.disabled ? "#6b7385" : "#dfe4ee", fontSize: 13, cursor: props.disabled ? "default" : "pointer" }}>
			<input type="checkbox" checked={props.checked} disabled={props.disabled} onChange={(e) => props.onChange(e.target.checked)} />
			{props.label}
		</label>
	);
}

/** 位图加载：fetch→createImageBitmap，主源失败走 /raw 兜底（涂鸦/全景同款教训） */
async function loadBitmap(uri: string, fallbackUri?: string): Promise<ImageBitmap | null> {
	for (const u of [uri, fallbackUri]) {
		if (!u) continue;
		try {
			const res = await fetch(u);
			if (!res.ok) continue;
			return await createImageBitmap(await res.blob());
		} catch { /* 试下一源 */ }
	}
	return null;
}
