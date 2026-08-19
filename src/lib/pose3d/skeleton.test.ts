import { describe, expect, it } from "vitest";
import {
	qFromEulerDeg,
	qRotate,
	qFromTo,
	vNorm,
	type Vec3,
} from "./vecmath";
import {
	JOINTS,
	JOINT_BY_NAME,
	EDITABLE_JOINTS,
	computeFK,
	sanitizePose,
	aimJointAt,
	eulerDegFromQuat,
	openposeKeypoints,
	OPENPOSE_KEYPOINT_JOINTS,
} from "./skeleton";
import {
	OPENPOSE_LIMBS,
	OPENPOSE_LIMB_COLORS,
	OPENPOSE_POINT_COLORS,
	drawOpenPoseFigure,
	type MiniCtx,
} from "./openposeDraw";
import { sanitizeStageScene, STAGE_MAX_MODELS } from "../stageScene";

const close = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

describe("vecmath", () => {
	it("欧拉↔四元数互逆", () => {
		const q = qFromEulerDeg(30, -45, 60);
		const e = eulerDegFromQuat(q);
		expect(close(e[0], 30, 1e-2)).toBe(true);
		expect(close(e[1], -45, 1e-2)).toBe(true);
		expect(close(e[2], 60, 1e-2)).toBe(true);
	});
	it("qRotate：绕 Y 转 90° 把 +Z 转到 +X", () => {
		const q = qFromEulerDeg(0, 90, 0);
		const v = qRotate(q, [0, 0, 1]);
		expect(close(v[0], 1, 1e-6)).toBe(true);
		expect(close(v[2], 0, 1e-6)).toBe(true);
	});
	it("qFromTo：把 from 精确转到 to；反向向量也有解", () => {
		const q = qFromTo([0, -1, 0], vNorm([1, 0, 0] as Vec3));
		const v = qRotate(q, [0, -1, 0]);
		expect(close(v[0], 1, 1e-6)).toBe(true);
		const q2 = qFromTo([0, 1, 0], [0, -1, 0]);
		const v2 = qRotate(q2, [0, 1, 0]);
		expect(close(v2[1], -1, 1e-6)).toBe(true);
	});
});

describe("skeleton FK", () => {
	it("骨骼定义自洽：父先子后、名字唯一、可编辑清单非空", () => {
		const seen = new Set<string>();
		for (const j of JOINTS) {
			expect(seen.has(j.name)).toBe(false);
			if (j.parent) expect(seen.has(j.parent)).toBe(true);
			seen.add(j.name);
		}
		expect(EDITABLE_JOINTS.length).toBeGreaterThan(10);
	});
	it("静止姿：头顶最高、双踝落地对称、总高约 1.6m", () => {
		const fk = computeFK({});
		expect(fk.pos.head[1]).toBeGreaterThan(1.4);
		expect(close(fk.pos.ankleL[1], fk.pos.ankleR[1])).toBe(true);
		expect(fk.pos.ankleL[1]).toBeLessThan(0.12);
		expect(close(fk.pos.ankleL[0], -fk.pos.ankleR[0])).toBe(true);
	});
	it("抬左肩 +90°（绕 Z）：左腕水平伸出", () => {
		// shoulderL 静止时手臂向下（elbow offset ≈ -Y）；绕 Z 转 +90° 把 -Y 转到 +X
		const fk = computeFK({ shoulderL: [0, 0, 90] });
		const sh = fk.pos.shoulderL;
		const wr = fk.pos.wristL;
		expect(wr[0]).toBeGreaterThan(sh[0] + 0.4); // 明显向 +X 展开
		expect(Math.abs(wr[1] - sh[1])).toBeLessThan(0.12); // 大致水平
	});
	it("腰转 180°（绕 Y）：面部标记转向 -Z", () => {
		const fk = computeFK({ hips: [0, 180, 0] });
		expect(fk.pos.nose[2]).toBeLessThan(0);
	});
});

describe("sanitizePose", () => {
	it("只认可编辑关节、过滤坏值、全零省略、角度归一", () => {
		const p = sanitizePose({
			shoulderL: [370, -190, 0], // 归一 10 / 170
			nose: [10, 10, 10], // 不可编辑 → 丢
			elbowR: [0, 0, 0], // 全零 → 省略
			kneeL: ["bad", 1, 2], // 坏值 → 0,1,2
			unknown: [1, 2, 3],
		});
		expect(p.shoulderL).toEqual([10, 170, 0]);
		expect(p.nose).toBeUndefined();
		expect(p.elbowR).toBeUndefined();
		expect((p as Record<string, unknown>).unknown).toBeUndefined();
		expect(p.kneeL).toEqual([0, 1, 2]);
	});
});

describe("aimJointAt（拖关节转父骨骼）", () => {
	it("把左腕拖到肘部正前方 → 左肘旋转后腕部朝 +Z", () => {
		const r = aimJointAt({}, "wristL", (() => {
			const fk = computeFK({});
			const e = fk.pos.elbowL;
			return [e[0], e[1], e[2] + 0.3] as Vec3;
		})());
		expect(r?.joint).toBe("elbowL");
		const fk2 = computeFK({ [r!.joint]: r!.euler });
		const e = fk2.pos.elbowL;
		const w = fk2.pos.wristL;
		const d = vNorm([w[0] - e[0], w[1] - e[1], w[2] - e[2]] as Vec3);
		expect(d[2]).toBeGreaterThan(0.99);
	});
	it("根关节/不可编辑父：返回 null", () => {
		expect(aimJointAt({}, "hips", [0, 0, 1])).toBeNull();
		// nose 的父 head 可编辑 → 有解；wristL 父 elbowL 可编辑 → 有解；找不可编辑父的例子：无（标记点都挂可编辑关节）
		expect(aimJointAt({}, "nope", [0, 0, 1])).toBeNull();
	});
});

describe("openpose 映射与绘制", () => {
	it("18 键点齐全且骨骼里都存在", () => {
		expect(OPENPOSE_KEYPOINT_JOINTS).toHaveLength(18);
		for (const n of OPENPOSE_KEYPOINT_JOINTS) expect(JOINT_BY_NAME[n]).toBeTruthy();
		expect(openposeKeypoints({})).toHaveLength(18);
	});
	it("肢体连线/颜色一一对应；点色 18 个", () => {
		expect(OPENPOSE_LIMBS).toHaveLength(17);
		expect(OPENPOSE_LIMB_COLORS).toHaveLength(17);
		expect(OPENPOSE_POINT_COLORS).toHaveLength(18);
	});
	it("drawOpenPoseFigure：null 键点跳过、可见键点画点", () => {
		const calls: string[] = [];
		const ctx: MiniCtx = {
			beginPath: () => calls.push("begin"),
			ellipse: () => calls.push("ellipse"),
			arc: () => calls.push("arc"),
			fill: () => calls.push("fill"),
			fillStyle: "",
			globalAlpha: 1,
		};
		const pts = Array.from({ length: 18 }, (_, i) => (i < 2 ? ([i * 10, 20] as [number, number]) : null));
		drawOpenPoseFigure(ctx, pts, 4);
		// 只有 [1,0] 一条肢体两端都可见 → 1 个 ellipse；2 个点 → 2 个 arc
		expect(calls.filter((c) => c === "ellipse")).toHaveLength(1);
		expect(calls.filter((c) => c === "arc")).toHaveLength(2);
	});
});

describe("sanitizeStageScene", () => {
	it("三类模型清洗：坏条目丢弃、色值白名单、缩放夹取、上限截断", () => {
		const doc = sanitizeStageScene({
			models: [
				{ id: "a", kind: "figure", pos: [1, 0, 2], rot: [0, 90, 0], scale: 99, pose: { shoulderL: [10, 0, 0] }, color: "#abcdef" },
				{ id: "b", kind: "prop", shape: "box", pos: [0, 0, 0], rot: [0, 0, 0], scale: 0.001, color: "red", size: [2, "x", 3] },
				{ id: "c", kind: "prop", shape: "torus", pos: [0, 0, 0], rot: [0, 0, 0], scale: 1 }, // 未知形状 → 丢
				{ id: "d", kind: "glb", assetId: "LC-abc", srcName: "chair.glb", pos: [0, 1, 0], rot: [0, 0, 0], scale: 2 },
				{ id: "e", kind: "glb", pos: [0, 0, 0], rot: [0, 0, 0], scale: 1 }, // 无 assetId → 丢
				null,
			],
		});
		expect(doc.models.map((m) => m.id)).toEqual(["a", "b", "d"]);
		const a = doc.models[0];
		expect(a.kind === "figure" && a.color).toBe("#abcdef");
		expect(a.scale).toBe(20);
		const b = doc.models[1];
		expect(b.kind === "prop" && b.color).toBeUndefined();
		expect(b.scale).toBe(0.05);
		expect(b.kind === "prop" && b.size).toEqual([2, 1, 3]);
	});
	it("上限 STAGE_MAX_MODELS", () => {
		const doc = sanitizeStageScene({
			models: Array.from({ length: STAGE_MAX_MODELS + 5 }, (_, i) => ({
				id: `m${i}`, kind: "prop", shape: "box", pos: [0, 0, 0], rot: [0, 0, 0], scale: 1,
			})),
		});
		expect(doc.models).toHaveLength(STAGE_MAX_MODELS);
	});
	it("非法输入回退空场景", () => {
		expect(sanitizeStageScene(null).models).toEqual([]);
		expect(sanitizeStageScene({ models: "x" }).models).toEqual([]);
	});
	it("拉伸倍率（第207轮拉边缩放）：逐轴夹取、≈[1,1,1] 省略、坏形状丢弃", () => {
		const doc = sanitizeStageScene({
			models: [
				{ id: "a", kind: "prop", shape: "box", pos: [0, 0, 0], rot: [0, 0, 0], scale: 1, stretch: [2, 0.001, 99] },
				{ id: "b", kind: "prop", shape: "box", pos: [0, 0, 0], rot: [0, 0, 0], scale: 1, stretch: [1, 1.001, 1] },
				{ id: "c", kind: "prop", shape: "box", pos: [0, 0, 0], rot: [0, 0, 0], scale: 1, stretch: [1, 2] },
			],
		});
		expect(doc.models[0].stretch).toEqual([2, 0.05, 20]);
		expect(doc.models[1].stretch).toBeUndefined();
		expect(doc.models[2].stretch).toBeUndefined();
	});
});
