/**
 * stageScene —— 3D 模型舞台的场景数据模型 + 载入清洗（纯逻辑层，可单测）。
 *
 * 场景 JSON 是三处宿主（涂鸦嵌入 / 720°全景嵌入 / 独立导演台）共用的落盘形态：
 * ⚠ 只存 引用与变换参数，绝不存 base64/位图（§7.1 膨胀事故模式）；GLB 模型凭
 * 资产 id 引用（字节走素材库/懒上传体系）。
 */
import { sanitizePose, type FigurePose } from "./pose3d/skeleton";

export const STAGE_MAX_MODELS = 30;

export type PropShape = "box" | "sphere" | "cylinder" | "cone" | "plane";

export const PROP_SHAPES: { shape: PropShape; label: string }[] = [
	{ shape: "box", label: "方块" },
	{ shape: "sphere", label: "球" },
	{ shape: "cylinder", label: "圆柱" },
	{ shape: "cone", label: "圆锥" },
	{ shape: "plane", label: "板" },
];

interface StageModelBase {
	id: string;
	/** 位置（米；导演台/涂鸦=地面原点系，全景=球心系） */
	pos: [number, number, number];
	/** 欧拉旋转（度，XYZ） */
	rot: [number, number, number];
	/** 统一缩放 */
	scale: number;
	/** 非等比拉伸倍率（本地 xyz，叠乘在 scale 上；缺省 [1,1,1]。选中框拉边（等比关）产生，第207轮） */
	stretch?: [number, number, number];
	name?: string;
}

export interface StageFigure extends StageModelBase {
	kind: "figure";
	pose: FigurePose;
	/** 人偶体色（默认灰白） */
	color?: string;
}

export interface StageProp extends StageModelBase {
	kind: "prop";
	shape: PropShape;
	color?: string;
	/** 非等比尺寸（米），缺省 [1,1,1]×scale */
	size?: [number, number, number];
}

export interface StageGlb extends StageModelBase {
	kind: "glb";
	/** 素材库资产 id（LC- 本地暂存或已上传 id） */
	assetId: string;
	srcName?: string;
}

export type StageModel = StageFigure | StageProp | StageGlb;

export interface StageSceneDoc {
	models: StageModel[];
}

const num = (v: unknown, fallback = 0): number => {
	const n = Number(v);
	return Number.isFinite(n) ? n : fallback;
};

const vec3 = (v: unknown, fallback: [number, number, number]): [number, number, number] => {
	if (!Array.isArray(v) || v.length !== 3) return [...fallback] as [number, number, number];
	return [num(v[0], fallback[0]), num(v[1], fallback[1]), num(v[2], fallback[2])];
};

const clampScale = (v: unknown): number => Math.min(20, Math.max(0.05, num(v, 1)));

/** 拉伸倍率清洗：合法三元组逐轴夹 0.05..20；≈[1,1,1]（全轴偏差 <0.5%）视为无拉伸返回 null 省落盘 */
export function sanitizeStretch(v: unknown): [number, number, number] | null {
	if (!Array.isArray(v) || v.length !== 3) return null;
	const s = v.map((n) => Math.min(20, Math.max(0.05, num(n, 1)))) as [number, number, number];
	return s.every((n) => Math.abs(n - 1) < 0.005) ? null : s;
}

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** 载入清洗：坏模型条目整体丢弃（与涂鸦 doc 清洗同哲学） */
export function sanitizeStageScene(raw: unknown): StageSceneDoc {
	const out: StageSceneDoc = { models: [] };
	const models = (raw as StageSceneDoc | null)?.models;
	if (!Array.isArray(models)) return out;
	for (const m of models) {
		if (out.models.length >= STAGE_MAX_MODELS) break;
		if (!m || typeof m !== "object" || typeof (m as StageModel).id !== "string") continue;
		const base: StageModelBase = {
			id: (m as StageModel).id,
			pos: vec3((m as StageModel).pos, [0, 0, 0]),
			rot: vec3((m as StageModel).rot, [0, 0, 0]),
			scale: clampScale((m as StageModel).scale),
		};
		const stretch = sanitizeStretch((m as StageModel).stretch);
		if (stretch) base.stretch = stretch;
		const name = (m as StageModel).name;
		if (typeof name === "string" && name.trim()) base.name = name.slice(0, 60);
		const kind = (m as StageModel).kind;
		if (kind === "figure") {
			const f = m as StageFigure;
			out.models.push({
				...base,
				kind: "figure",
				pose: sanitizePose(f.pose),
				...(typeof f.color === "string" && COLOR_RE.test(f.color) ? { color: f.color } : {}),
			});
		} else if (kind === "prop") {
			const p = m as StageProp;
			if (!PROP_SHAPES.some((s) => s.shape === p.shape)) continue;
			out.models.push({
				...base,
				kind: "prop",
				shape: p.shape,
				...(typeof p.color === "string" && COLOR_RE.test(p.color) ? { color: p.color } : {}),
				...(Array.isArray(p.size)
					? { size: vec3(p.size, [1, 1, 1]).map((n) => Math.min(50, Math.max(0.02, n))) as [number, number, number] }
					: {}),
			});
		} else if (kind === "glb") {
			const g = m as StageGlb;
			if (typeof g.assetId !== "string" || !g.assetId) continue;
			out.models.push({
				...base,
				kind: "glb",
				assetId: g.assetId,
				...(typeof g.srcName === "string" && g.srcName ? { srcName: g.srcName.slice(0, 120) } : {}),
			});
		}
	}
	return out;
}
