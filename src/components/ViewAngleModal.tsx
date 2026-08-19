/**
 * ViewAngleModal —— 「转视角」多角度编辑器（App 根挂载，viewAngleStore 唤起）。
 *
 * 交互（用户三轮定稿）：**相机固定面向屏幕，操作的是画面本身**——
 *  - 鼠标拖动＝转动图片方向（水平环绕/垂直俯仰，CSS 3D 卡片预览，松手吸附 15° 档）；
 *  - 滚轮＝图像缩放＝等效相机距离（图像越大离得越近，换算景别档 shotFromScale）；
 *  - WASD＝相机上下左右平移取景（画面反向移动，入构图短语）；
 *  - **取景框固定**：不同镜头不同框——标准/荷兰角=矩形三分线框（荷兰角把画面转 15°）、
 *    鱼眼=圆形框+**桶形畸变简易预览**（canvas 逐像素重采样；真实效果仍靠图像模型生成）。
 * 预设/滑杆与取景器双向同步；提交走 viewAngleOp（右侧建节点+标准生成管线）。
 * ⚠ 预览图字节 fetch→createImageBitmap（asset:// 直喂 canvas 会污染，thumbGen 同款教训）；
 *   取不到位图时回退 <img> 平铺预览（无畸变效果，不阻塞功能）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { useViewAngleStore } from "@/store/viewAngleStore";
import { useCatalogStore } from "@/store/catalogStore";
import { submitViewAngle } from "@/canvas/viewAngleOp";
import {
	ANGLE_STEP, DEFAULT_VIEW, SHOT_LABELS, SHOT_SCALES, shotFromScale, VIEW_PRESETS, type ViewAngleParams,
} from "@/lib/viewAngle";
import { getChannelModelsForNodeType, type ModelOption } from "@/services/adapters/channelAdapter";

const PREVIEW_W = 320;
const PREVIEW_H = 240;

/** 位图 contain 适配画到 W×H；fisheye=桶形畸变重采样（dst 半径 r → src 半径 r^1.6，中心放大边缘压缩） */
function drawPreview(canvas: HTMLCanvasElement, bmp: ImageBitmap, fisheye: boolean): void {
	canvas.width = PREVIEW_W;
	canvas.height = PREVIEW_H;
	const ctx = canvas.getContext("2d")!;
	ctx.clearRect(0, 0, PREVIEW_W, PREVIEW_H);
	const s = Math.min(PREVIEW_W / bmp.width, PREVIEW_H / bmp.height);
	const dw = bmp.width * s;
	const dh = bmp.height * s;
	const dx = (PREVIEW_W - dw) / 2;
	const dy = (PREVIEW_H - dh) / 2;
	if (!fisheye) {
		ctx.drawImage(bmp, dx, dy, dw, dh);
		return;
	}
	const off = document.createElement("canvas");
	off.width = PREVIEW_W;
	off.height = PREVIEW_H;
	const octx = off.getContext("2d")!;
	octx.drawImage(bmp, dx, dy, dw, dh);
	const src = octx.getImageData(0, 0, PREVIEW_W, PREVIEW_H);
	const out = ctx.createImageData(PREVIEW_W, PREVIEW_H);
	const cx = PREVIEW_W / 2;
	const cy = PREVIEW_H / 2;
	const R = Math.min(cx, cy);
	for (let y = 0; y < PREVIEW_H; y++) {
		for (let x = 0; x < PREVIEW_W; x++) {
			const nx = (x - cx) / R;
			const ny = (y - cy) / R;
			const r = Math.hypot(nx, ny);
			const o = (y * PREVIEW_W + x) * 4;
			if (r > 1.15) continue; // 圆框外留空
			const f = r > 0 ? Math.pow(r, 1.6) / r : 0;
			const sx = Math.round(cx + nx * f * R);
			const sy = Math.round(cy + ny * f * R);
			if (sx < 0 || sy < 0 || sx >= PREVIEW_W || sy >= PREVIEW_H) continue;
			const i = (sy * PREVIEW_W + sx) * 4;
			out.data[o] = src.data[i];
			out.data[o + 1] = src.data[i + 1];
			out.data[o + 2] = src.data[i + 2];
			out.data[o + 3] = src.data[i + 3];
		}
	}
	ctx.putImageData(out, 0, 0);
}

export default function ViewAngleModal() {
	const session = useViewAngleStore((s) => s.session);
	const close = useViewAngleStore((s) => s.close);

	const [presetId, setPresetId] = useState<string>("custom");
	const [params, setParams] = useState<ViewAngleParams>(DEFAULT_VIEW);
	const [scale, setScale] = useState(1); // 等效相机距离（取景器滚轮），与 params.shot 联动
	const [promptOn, setPromptOn] = useState(false);
	const [custom, setCustom] = useState("");
	const [modelKey, setModelKey] = useState("");
	const [bitmap, setBitmap] = useState<ImageBitmap | null>(null);
	const [dragging, setDragging] = useState(false);

	const canvasRef = useRef<HTMLCanvasElement>(null);
	const paramsRef = useRef(params);
	paramsRef.current = params;
	const scaleRef = useRef(scale);
	scaleRef.current = scale;

	// 图片能力模型：订阅 catalog——弹窗打开早于 catalog 拉取完成时，到货即刷新列表
	// （实测坑：只按 session 记忆列表会永远停在打开瞬间的快照）
	const catalog = useCatalogStore((s) => s.catalog);
	const models = useMemo<ModelOption[]>(
		() => (session ? getChannelModelsForNodeType("image.gen") : []),
		[session, catalog], // eslint-disable-line react-hooks/exhaustive-deps
	);
	// 会话开启：复位参数 + 载预览位图（fetch 字节防画布污染；失败回退 <img>）
	useEffect(() => {
		if (!session) return;
		setPresetId("custom");
		setParams(DEFAULT_VIEW);
		setScale(1);
		setPromptOn(false);
		setCustom("");
		setModelKey("");
		setBitmap(null);
		let alive = true;
		(async () => {
			for (const uri of [session.previewUri, session.previewFallbackUri]) {
				if (!uri) continue;
				try {
					const resp = await fetch(uri);
					if (!resp.ok) throw new Error();
					const b = await createImageBitmap(await resp.blob());
					if (alive) setBitmap(b);
					return;
				} catch { /* 试下一个源；全失败回退 img 预览 */ }
			}
		})();
		return () => { alive = false; };
	}, [session]);
	// 默认模型：锁定 gpt-image-2 家族第一个；用户已选且仍在列表中则不动（catalog 中途到货不打断选择）
	useEffect(() => {
		if (!session || !models.length) return;
		setModelKey((cur) => {
			if (cur && models.some((m) => m.id === cur)) return cur;
			const gpt = models.find((m) => m.familyId === "fam-gpt-image-2")
				?? models.find((m) => /gpt[- ]?image/i.test(`${m.id} ${m.label}`));
			return (gpt ?? models[0])?.id ?? "";
		});
	}, [session, models]);

	// 取景器画布重绘（位图/镜头变化）
	useEffect(() => {
		if (bitmap && canvasRef.current) drawPreview(canvasRef.current, bitmap, params.lens === "fisheye");
	}, [bitmap, params.lens]);

	// Esc 关闭 + WASD 平移取景（capture 拦截；输入框聚焦时放行）
	useEffect(() => {
		if (!session) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") { e.stopPropagation(); close(); return; }
			const tag = (e.target as HTMLElement)?.tagName;
			if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") return;
			const k = e.key.toLowerCase();
			if (!"wasd".includes(k) || !k) return;
			e.stopPropagation();
			const STEP = 4;
			const clamp = (v: number) => Math.max(-40, Math.min(40, v));
			setPresetId("custom");
			setParams((p) => ({
				...p,
				panX: clamp((p.panX ?? 0) + (k === "d" ? STEP : k === "a" ? -STEP : 0)),
				panY: clamp((p.panY ?? 0) + (k === "s" ? STEP : k === "w" ? -STEP : 0)),
			}));
		};
		window.addEventListener("keydown", onKey, { capture: true });
		return () => window.removeEventListener("keydown", onKey, { capture: true });
	}, [session, close]);

	if (!session) return null;

	const applyPreset = (id: string) => {
		if (id === "custom") { setPresetId("custom"); setParams((p) => ({ az: p.az, el: p.el, shot: p.shot, panX: p.panX, panY: p.panY })); return; }
		const v = VIEW_PRESETS.find((x) => x.id === id);
		if (v) {
			setPresetId(id);
			setParams({ ...v.params, panX: 0, panY: 0 });
			setScale(SHOT_SCALES[v.params.shot] ?? 1);
		}
	};
	const reset = () => { setPresetId("custom"); setParams(DEFAULT_VIEW); setScale(1); setPromptOn(false); setCustom(""); };
	const onSubmit = () => {
		if (!modelKey) { alert("无可用图片模型：请检查管理端连接与目录拉取"); return; }
		const err = submitViewAngle(session, params, promptOn ? custom : "", modelKey);
		if (err) { alert(err); return; }
		close();
	};

	/** 取景器拖动：转动画面方向（自由角度实时预览，松手吸附 15° 档） */
	const beginRotateDrag = (e: React.MouseEvent) => {
		if (e.button !== 0) return;
		e.preventDefault();
		setDragging(true);
		setPresetId("custom");
		const start = { x: e.clientX, y: e.clientY, az: paramsRef.current.az, el: paramsRef.current.el };
		const onMove = (me: MouseEvent) => {
			const az = (((start.az + (me.clientX - start.x) * 0.5) % 360) + 360) % 360;
			const el = Math.max(-90, Math.min(90, start.el + (start.y - me.clientY) * 0.5));
			setParams((p) => ({ ...p, az, el }));
		};
		const onUp = () => {
			window.removeEventListener("mousemove", onMove);
			window.removeEventListener("mouseup", onUp);
			setDragging(false);
			// 吸附 15° 档（语言档位化：句式对整档描述最稳）
			setParams((p) => ({
				...p,
				az: (Math.round(p.az / ANGLE_STEP) * ANGLE_STEP) % 360,
				el: Math.max(-90, Math.min(90, Math.round(p.el / ANGLE_STEP) * ANGLE_STEP)),
			}));
		};
		window.addEventListener("mousemove", onMove);
		window.addEventListener("mouseup", onUp);
	};

	// 滚轮=等效距离（native 非 passive 才能 preventDefault——纹章滚轮同款）
	const viewportRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const el = viewportRef.current;
		if (!el) return;
		const onWheel = (e: WheelEvent) => {
			e.preventDefault();
			e.stopPropagation();
			setPresetId("custom");
			setScale((v) => {
				const next = Math.max(0.4, Math.min(2, v * Math.exp(-e.deltaY * 0.001)));
				setParams((p) => ({ ...p, shot: shotFromScale(next) }));
				return next;
			});
		};
		el.addEventListener("wheel", onWheel, { passive: false });
		return () => el.removeEventListener("wheel", onWheel);
	}, [session]); // eslint-disable-line react-hooks/exhaustive-deps

	const lens = params.lens;
	const panX = params.panX ?? 0;
	const panY = params.panY ?? 0;
	// 相机固定：画面反向表达相机运动——rotateY(az) 转方向、平移取反、scale=距离
	const imgTransform =
		`translate(${-panX}%, ${-panY}%) scale(${scale}) perspective(700px) rotateX(${params.el}deg) rotateY(${params.az}deg)` +
		(lens === "dutch" ? " rotate(15deg)" : "");

	const presetBtn = (on: boolean) =>
		`rounded-md px-2.5 py-1.5 text-xs whitespace-nowrap cursor-pointer transition-colors ${
			on ? "bg-violet-500/30 text-white border border-violet-400/60" : "text-white/70 hover:text-white bg-white/6 hover:bg-white/12 border border-white/10"}`;

	return (
		<div style={{ position: "fixed", inset: 0, zIndex: 100260, background: "rgba(4,6,10,0.55)", display: "flex", alignItems: "center", justifyContent: "center" }}
			onMouseDown={close}>
			<div onMouseDown={(e) => e.stopPropagation()}
				style={{ width: 700, maxWidth: "96vw", borderRadius: 14, border: "1px solid rgba(255,255,255,0.12)", background: "#12151d", boxShadow: "0 18px 60px rgba(0,0,0,0.65)", padding: 16 }}>
				{/* 标题行 */}
				<div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
					<span style={{ fontSize: 14.5, fontWeight: 600, color: "#fff" }}>多角度编辑器</span>
					<span style={{ marginLeft: 10, fontSize: 12, color: "rgba(255,255,255,0.45)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 280 }}>
						{session.source.name || "图片"} · 转视角
					</span>
					<div style={{ flex: 1 }} />
					<button onClick={close} title="关闭（Esc）"
						className="rounded-md p-1 text-white/60 hover:text-white hover:bg-white/10 cursor-pointer">
						<X className="h-4 w-4" />
					</button>
				</div>

				{/* 预设行 */}
				<div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
					<button className={presetBtn(presetId === "custom")} onClick={() => applyPreset("custom")}>自定义</button>
					{VIEW_PRESETS.map((v) => (
						<button key={v.id} className={presetBtn(presetId === v.id)} onClick={() => applyPreset(v.id)}>{v.label}</button>
					))}
				</div>

				<div style={{ display: "flex", gap: 18 }}>
					{/* ── 左：取景器（相机固定；拖动转画面 / 滚轮距离 / WASD 平移） ── */}
					<div style={{ flexShrink: 0 }}>
						<div ref={viewportRef} onMouseDown={beginRotateDrag}
							style={{ position: "relative", width: PREVIEW_W, height: PREVIEW_H, borderRadius: 10, overflow: "hidden", background: "#07090e", border: "1px solid rgba(255,255,255,0.09)", cursor: dragging ? "grabbing" : "grab" }}>
							{/* 线框球轮廓（用户定稿的观感；相机固定语义不变——球只是包着画面的可视化外壳） */}
							<svg width={PREVIEW_W} height={PREVIEW_H} viewBox={`0 0 ${PREVIEW_W} ${PREVIEW_H}`}
								style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
								<g transform={`translate(${PREVIEW_W / 2},${PREVIEW_H / 2})`} stroke="rgba(255,255,255,0.20)" fill="none" strokeWidth="1">
									<circle r={110} />
									{[-60, -30, 0, 30, 60].map((el) => {
										const e = (el * Math.PI) / 180;
										return <ellipse key={el} cy={-110 * Math.sin(e) * 0.95} rx={110 * Math.cos(e)} ry={110 * Math.cos(e) * 0.24} />;
									})}
									{[0, 36, 72, 108, 144].map((az) => (
										<ellipse key={az} rx={110 * Math.abs(Math.cos((az * Math.PI) / 180))} ry={110} opacity={0.7} />
									))}
								</g>
							</svg>
							{/* 画面（CSS 3D 卡片嵌在球心；鱼眼时 canvas 已带桶形畸变） */}
							<div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", transform: imgTransform, transition: dragging ? "none" : "transform 120ms ease-out", willChange: "transform" }}>
								{bitmap ? (
									<canvas ref={canvasRef} style={{ width: 190, height: 142, pointerEvents: "none", boxShadow: "0 6px 24px rgba(0,0,0,0.6)" }} />
								) : (
									<img src={session.previewUri} alt="" draggable={false}
										style={{ maxWidth: 190, maxHeight: 142, objectFit: "contain", pointerEvents: "none", boxShadow: "0 6px 24px rgba(0,0,0,0.6)" }} />
								)}
							</div>
							{/* 取景框（固定不动；镜头不同框不同）：外部压暗靠超大 box-shadow */}
							{lens === "fisheye" ? (
								<div style={{ position: "absolute", left: PREVIEW_W / 2 - 95, top: PREVIEW_H / 2 - 95, width: 190, height: 190, borderRadius: 999, border: "1.5px solid rgba(255,255,255,0.85)", boxShadow: "0 0 0 9999px rgba(0,0,0,0.55)", pointerEvents: "none" }} />
							) : (
								<div style={{ position: "absolute", left: (PREVIEW_W - 220) / 2, top: (PREVIEW_H - 160) / 2, width: 220, height: 160, border: "1.5px solid rgba(255,255,255,0.85)", boxShadow: "0 0 0 9999px rgba(0,0,0,0.55)", pointerEvents: "none" }}>
									{/* 三分线 */}
									<div style={{ position: "absolute", left: "33.3%", top: 0, bottom: 0, width: 1, background: "rgba(255,255,255,0.25)" }} />
									<div style={{ position: "absolute", left: "66.6%", top: 0, bottom: 0, width: 1, background: "rgba(255,255,255,0.25)" }} />
									<div style={{ position: "absolute", top: "33.3%", left: 0, right: 0, height: 1, background: "rgba(255,255,255,0.25)" }} />
									<div style={{ position: "absolute", top: "66.6%", left: 0, right: 0, height: 1, background: "rgba(255,255,255,0.25)" }} />
								</div>
							)}
							{/* 相机图标（固定，示意相机不动） */}
							<div style={{ position: "absolute", right: 6, top: 6, fontSize: 11, color: "rgba(255,255,255,0.55)", background: "rgba(0,0,0,0.45)", borderRadius: 5, padding: "2px 6px", pointerEvents: "none" }}>
								📷 固定机位 · {lens === "fisheye" ? "鱼眼" : lens === "dutch" ? "荷兰角" : "标准"}镜头
							</div>
						</div>
						<div style={{ marginTop: 6, fontSize: 11, color: "rgba(255,255,255,0.45)", width: PREVIEW_W, lineHeight: 1.6 }}>
							拖动＝转动画面方向 · 滚轮＝距离（{Math.round(scale * 100)}%，{SHOT_LABELS[params.shot]}）
							· WASD＝平移取景（{panX || panY ? `${panX}%, ${panY}%` : "居中"}）
							{lens === "fisheye" && <>　·　鱼眼畸变为简易预览，实际效果由模型生成</>}
						</div>
					</div>

					{/* ── 右：参数区（与取景器双向同步） ── */}
					<div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 13 }}>
						<label style={rowCss}>
							<span style={labelCss}>水平环绕</span>
							<input type="range" min={0} max={345} step={ANGLE_STEP} value={Math.round(params.az / ANGLE_STEP) * ANGLE_STEP % 360}
								onChange={(e) => { setPresetId("custom"); setParams((p) => ({ ...p, az: Number(e.target.value) })); }} style={rangeCss} />
							<span style={valCss}>{Math.round(params.az)}°</span>
						</label>
						<label style={rowCss}>
							<span style={labelCss}>垂直俯仰</span>
							<input type="range" min={-90} max={90} step={ANGLE_STEP} value={Math.round(params.el / ANGLE_STEP) * ANGLE_STEP}
								onChange={(e) => { setPresetId("custom"); setParams((p) => ({ ...p, el: Number(e.target.value) })); }} style={rangeCss} />
							<span style={valCss}>{Math.round(params.el)}°</span>
						</label>
						<label style={rowCss}>
							<span style={labelCss}>景别缩放</span>
							<input type="range" min={0} max={4} step={1} value={params.shot}
								onChange={(e) => {
									const shot = Number(e.target.value);
									setPresetId("custom");
									setParams((p) => ({ ...p, shot }));
									setScale(SHOT_SCALES[shot] ?? 1);
								}} style={rangeCss} />
							<span style={valCss}>{SHOT_LABELS[params.shot]}</span>
						</label>
						{lens && (
							<div style={{ fontSize: 11.5, color: "#a5f3fc" }}>
								镜头特效：{lens === "fisheye" ? "鱼眼畸变" : "荷兰角倾斜"}（预设附带，切换预设或复位取消）
							</div>
						)}
						<label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12.5, color: "rgba(255,255,255,0.8)", cursor: "pointer" }}>
							<span style={labelCss}>提示词</span>
							<input type="checkbox" checked={promptOn} onChange={(e) => setPromptOn(e.target.checked)} style={{ accentColor: "#22d3ee" }} />
							<span style={{ fontSize: 11.5, color: "rgba(255,255,255,0.45)" }}>附加自由描述（追加在视角指令之后）</span>
						</label>
						{promptOn && (
							<textarea value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="补充要求，如：夜晚氛围、地面加积水反光…"
								style={{ minHeight: 48, padding: "6px 8px", fontSize: 12.5, borderRadius: 8, resize: "vertical", color: "#fff", background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.14)", outline: "none" }} />
						)}
						<label style={rowCss}>
							<span style={labelCss}>模型</span>
							<select value={modelKey} onChange={(e) => setModelKey(e.target.value)}
								style={{ flex: 1, minWidth: 0, padding: "6px 8px", fontSize: 12.5, borderRadius: 8, color: "#fff", background: "#1a1f2b", border: "1px solid rgba(255,255,255,0.14)", outline: "none" }}>
								{models.map((m) => (
									<option key={m.id} value={m.id}>{m.label}{m.modeName ? `（${m.modeName}）` : ""}</option>
								))}
							</select>
						</label>
					</div>
				</div>

				{/* 底部操作行 */}
				<div style={{ display: "flex", alignItems: "center", marginTop: 16 }}>
					<button onClick={reset}
						className="flex items-center gap-1 rounded-md px-2 py-1.5 text-xs text-white/60 hover:text-white hover:bg-white/10 cursor-pointer">
						⟲ 重置参数
					</button>
					<div style={{ flex: 1 }} />
					<span style={{ fontSize: 11.5, color: "rgba(255,255,255,0.4)", marginRight: 10 }}>
						提交后在画布新建图片节点生成（可在节点上换模型重跑）
					</span>
					<button onClick={onSubmit} title="生成该视角"
						className="rounded-full w-9 h-9 flex items-center justify-center bg-violet-500 hover:bg-violet-400 text-white cursor-pointer text-base">↑</button>
				</div>
			</div>
		</div>
	);
}

const rowCss: React.CSSProperties = { display: "flex", alignItems: "center", gap: 10 };
const labelCss: React.CSSProperties = { width: 60, flexShrink: 0, fontSize: 12.5, color: "rgba(255,255,255,0.8)" };
const valCss: React.CSSProperties = { width: 44, flexShrink: 0, textAlign: "right", fontSize: 12.5, fontWeight: 600, color: "#fff" };
const rangeCss: React.CSSProperties = { flex: 1, minWidth: 0, accentColor: "#22d3ee" };
