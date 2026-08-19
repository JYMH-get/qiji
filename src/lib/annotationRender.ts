/**
 * annotationRender —— 标注元素 → Konva 节点配置的唯一映射（纯函数，无 Konva 依赖）。
 *
 * 编辑器（react-konva JSX）与导出（离屏 Konva.Stage 重绘原尺寸合成图）共用同一份配置，
 * 保证「编辑所见 = 导出所得」；改任何元素外观只改这里一处。
 */
import type { AnnoElement, AnnoMask } from "@/lib/annotation";

export type KonvaCls = "Line" | "Arrow" | "Rect" | "Ellipse" | "Path" | "Image" | "Text" | "Circle";

export interface KonvaSpec {
	cls: KonvaCls;
	config: Record<string, unknown>;
}

/** PNG 章/3D 模型层的图像查找表（编辑器/导出各自组装；纯函数经参数拿图像，保持无副作用可测） */
export interface RenderCtx {
	stampImages?: Record<string, unknown>; // stampId → CanvasImageSource（unknown 避免 lib 依赖 DOM 类型）
	model3dImages?: Record<string, unknown>; // 3D 模型层元素 id → 离屏重渲的透明位图（model3dRender 组装）
}

/** 笔迹贝塞尔插值张力：配合 RDP 简化即「停顿转曲线」的平滑观感 */
export const PEN_TENSION = 0.5;

/**
 * 内置矢量章（0..100 视口路径，数据在 [stampShapes.ts](./stampShapes.ts)——annotation 的
 * 涂抹切段也要用，独立成模块防循环依赖；这里 re-export 维持既有 import 面）。
 * 渲染按元素外接矩形 scaleX/scaleY 缩放、strokeScaleEnabled=false 保持描边宽度不变形。
 */
export { BUILTIN_STAMPS } from "@/lib/stampShapes";
import { BUILTIN_STAMPS } from "@/lib/stampShapes";

/** 虚线元素：按线宽出虚线段（长3宽/空2宽，粗细观感一致） */
const dashOf = (el: { dashed?: boolean; width: number }) =>
	el.dashed ? { dash: [el.width * 3, el.width * 2] } : {};

/**
 * 虚线橡皮的分段参数：挖孔段=保留段，随笔刷直径取比例（单一来源供编辑/导出共用）。
 * dashScale=密度倍率（涂抹时滚轮调节，<1 更密 >1 更疏）；下限 2 防退化成实线观感。
 */
export function maskDashFor(width: number, dashScale = 1): number[] {
	const d = Math.max(2, width * 0.8 * dashScale);
	return [d, d];
}

/**
 * 蒙版 → Konva 节点配置（destination-out 挖孔；编辑与导出共用）。
 * anchor=元素锚点（蒙版存的是相对坐标）；正常笔刷=圆帽粗线；dashedLine=**沿笔刷路径方向**
 * 间隔挖孔（dash 分段，平头防段间糊连）；单点「点擦」退化为圆
 * （canvas 零长度圆帽线段不出墨，必须用 Circle）。⚠ 必须放在**被 cache 的隔离组**内，
 * 否则 destination-out 会把整层（含底下的原图层之外的标注）一起挖穿。
 */
export function maskSpec(mask: AnnoMask, anchor: { x: number; y: number }): KonvaSpec {
	const pts = mask.points.map((v, i) => (i % 2 === 0 ? v + anchor.x : v + anchor.y));
	let ext = 0;
	for (let i = 2; i + 1 < pts.length; i += 2) ext = Math.max(ext, Math.hypot(pts[i] - pts[0], pts[i + 1] - pts[1]));
	if (ext < 0.01) {
		return {
			cls: "Circle",
			config: { x: pts[0], y: pts[1], radius: Math.max(0.5, mask.width / 2), fill: "#000", listening: false, globalCompositeOperation: "destination-out" },
		};
	}
	return {
		cls: "Line",
		config: {
			points: pts,
			stroke: "#000",
			strokeWidth: mask.width,
			lineCap: mask.dashedLine ? "butt" : "round",
			lineJoin: "round",
			listening: false,
			globalCompositeOperation: "destination-out",
			...(mask.dashedLine ? { dash: maskDashFor(mask.width, mask.dashScale ?? 1) } : {}),
		},
	};
}

export function konvaSpecFor(el: AnnoElement, ctx?: RenderCtx): KonvaSpec {
	switch (el.kind) {
		case "pen":
			return {
				cls: "Line",
				config: {
					points: el.points,
					stroke: el.color,
					strokeWidth: el.width,
					tension: PEN_TENSION,
					lineCap: el.dashed ? "butt" : "round", // 圆头会把短虚线段糊成圆点
					lineJoin: "round",
					...dashOf(el),
				},
			};
		case "arrow":
			return {
				cls: "Arrow",
				config: {
					points: el.points,
					stroke: el.color,
					fill: el.color, // 箭头头部实心同色
					strokeWidth: el.width,
					pointerLength: Math.max(10, el.width * 3.5),
					pointerWidth: Math.max(9, el.width * 3),
					lineCap: el.dashed ? "butt" : "round",
					...dashOf(el),
				},
			};
		case "stamp": {
			const builtin = el.builtin ? BUILTIN_STAMPS[el.builtin] : undefined;
			if (builtin) {
				return {
					cls: "Path",
					config: {
						x: el.x,
						y: el.y,
						data: builtin.path,
						scaleX: el.w / 100,
						scaleY: el.h / 100,
						strokeScaleEnabled: false, // 缩放不放大描边
						stroke: el.color,
						strokeWidth: el.width,
						...(el.fill ? { fill: el.color } : {}),
						...dashOf(el),
					},
				};
			}
			const img = el.stampId ? ctx?.stampImages?.[el.stampId] : undefined;
			if (img) {
				// PNG 章没有描边可虚线：被虚线橡皮涂到 → 半透明「虚化」表达前后关系
				return { cls: "Image", config: { x: el.x, y: el.y, width: el.w, height: el.h, image: img, ...(el.dashed ? { opacity: 0.45 } : {}) } };
			}
			// 章图像缺失（跨设备/章库被清）：虚线占位框，可选中删除或换章
			return {
				cls: "Rect",
				config: { x: el.x, y: el.y, width: el.w, height: el.h, stroke: el.color, strokeWidth: Math.max(1, el.width / 2), dash: [6, 4] },
			};
		}
		case "rect":
			return {
				cls: "Rect",
				config: {
					x: el.x,
					y: el.y,
					width: el.w,
					height: el.h,
					stroke: el.color,
					strokeWidth: el.width,
					...(el.fill ? { fill: el.color } : {}),
					...dashOf(el),
				},
			};
		case "ellipse":
			return {
				cls: "Ellipse",
				config: {
					// Konva.Ellipse 以圆心+半径定位；模型存外接矩形，这里换算
					x: el.x + el.w / 2,
					y: el.y + el.h / 2,
					radiusX: el.w / 2,
					radiusY: el.h / 2,
					stroke: el.color,
					strokeWidth: el.width,
					...(el.fill ? { fill: el.color } : {}),
					...dashOf(el),
				},
			};
		case "model3d": {
			const m3 = ctx?.model3dImages?.[el.id];
			if (m3) {
				return { cls: "Image", config: { x: el.x, y: el.y, width: el.w, height: el.h, image: m3 } };
			}
			// 位图未就绪（离屏渲染中/three 加载失败）：虚线占位框
			return {
				cls: "Rect",
				config: { x: el.x, y: el.y, width: el.w, height: el.h, stroke: "#22d3ee", strokeWidth: 2, dash: [8, 6] },
			};
		}
		case "text":
			return {
				cls: "Text",
				config: {
					x: el.x,
					y: el.y,
					text: el.text,
					fontSize: el.fontSize,
					fill: el.color,
					fontStyle: "bold",
					// 深浅底图上都可读：细描边 + 投影
					shadowColor: "rgba(0,0,0,0.65)",
					shadowBlur: Math.max(2, el.fontSize / 10),
					shadowOffsetY: 1,
				},
			};
	}
}
