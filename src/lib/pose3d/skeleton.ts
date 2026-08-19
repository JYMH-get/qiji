/**
 * skeleton —— 可动人偶的骨骼定义 + FK + 姿势序列化（纯逻辑层，可单测）。
 *
 * 约定：人物面向 +Z、上方 +Y、人物左手侧 +X；静止姿=自然站立（手臂下垂微张）。
 * 姿势只存「可编辑关节的欧拉角（度）」；渲染层（modelStage）按同一份定义搭建
 * three 骨架，两边凭 JOINTS 单一来源对齐。标记点（鼻/眼/耳/腕/踝）是不可编辑
 * 的叶子，只为 OpenPose 姿势图提供键点位置。
 */
import {
	type Quat,
	type Vec3,
	QUAT_IDENTITY,
	qFromEulerDeg,
	qFromTo,
	qConj,
	qMul,
	qRotate,
	vAdd,
	vNorm,
} from "./vecmath";

export interface JointDef {
	name: string;
	parent: string | null;
	/** 静止姿下相对父关节的偏移（米） */
	offset: Vec3;
	/** 可被用户旋转（false=纯标记点/叶子） */
	editable: boolean;
	/** 中文名（关节列表 UI 用） */
	label?: string;
}

/** 骨骼单一来源：顺序=父先子后（FK 一遍扫过即可） */
export const JOINTS: JointDef[] = [
	{ name: "hips", parent: null, offset: [0, 0.95, 0], editable: true, label: "腰" },
	{ name: "spine", parent: "hips", offset: [0, 0.1, 0], editable: true, label: "脊柱" },
	{ name: "chest", parent: "spine", offset: [0, 0.15, 0], editable: true, label: "胸" },
	{ name: "neck", parent: "chest", offset: [0, 0.2, 0], editable: true, label: "颈" },
	{ name: "head", parent: "neck", offset: [0, 0.08, 0], editable: true, label: "头" },
	// 头部标记点（OpenPose 面部键点）
	{ name: "nose", parent: "head", offset: [0, 0.1, 0.09], editable: false },
	{ name: "eyeL", parent: "head", offset: [0.033, 0.13, 0.08], editable: false },
	{ name: "eyeR", parent: "head", offset: [-0.033, 0.13, 0.08], editable: false },
	{ name: "earL", parent: "head", offset: [0.075, 0.1, 0.005], editable: false },
	{ name: "earR", parent: "head", offset: [-0.075, 0.1, 0.005], editable: false },
	// 左臂（人物左=+X）
	{ name: "shoulderL", parent: "chest", offset: [0.18, 0.17, 0], editable: true, label: "左肩" },
	{ name: "elbowL", parent: "shoulderL", offset: [0.05, -0.27, 0], editable: true, label: "左肘" },
	{ name: "wristL", parent: "elbowL", offset: [0.02, -0.26, 0], editable: false },
	// 右臂
	{ name: "shoulderR", parent: "chest", offset: [-0.18, 0.17, 0], editable: true, label: "右肩" },
	{ name: "elbowR", parent: "shoulderR", offset: [-0.05, -0.27, 0], editable: true, label: "右肘" },
	{ name: "wristR", parent: "elbowR", offset: [-0.02, -0.26, 0], editable: false },
	// 左腿
	{ name: "hipL", parent: "hips", offset: [0.09, -0.05, 0], editable: true, label: "左胯" },
	{ name: "kneeL", parent: "hipL", offset: [0, -0.42, 0], editable: true, label: "左膝" },
	{ name: "ankleL", parent: "kneeL", offset: [0, -0.41, 0], editable: false },
	// 右腿
	{ name: "hipR", parent: "hips", offset: [-0.09, -0.05, 0], editable: true, label: "右胯" },
	{ name: "kneeR", parent: "hipR", offset: [0, -0.42, 0], editable: true, label: "右膝" },
	{ name: "ankleR", parent: "kneeR", offset: [0, -0.41, 0], editable: false },
];

export const JOINT_BY_NAME: Record<string, JointDef> = Object.fromEntries(
	JOINTS.map((j) => [j.name, j]),
);

export const EDITABLE_JOINTS = JOINTS.filter((j) => j.editable).map((j) => j.name);

/** 姿势 = 可编辑关节名 → 欧拉角（度，XYZ）。缺省关节视为 [0,0,0]。 */
export type FigurePose = Record<string, [number, number, number]>;

const clampDeg = (n: number) => {
	if (!Number.isFinite(n)) return 0;
	// 归一到 (-180, 180]
	let d = n % 360;
	if (d > 180) d -= 360;
	if (d <= -180) d += 360;
	return Math.round(d * 100) / 100;
};

/** 载入清洗：只认可编辑关节、有限数值、全零省略 */
export function sanitizePose(raw: unknown): FigurePose {
	const out: FigurePose = {};
	if (!raw || typeof raw !== "object") return out;
	for (const name of EDITABLE_JOINTS) {
		const v = (raw as Record<string, unknown>)[name];
		if (!Array.isArray(v) || v.length !== 3) continue;
		const e: [number, number, number] = [clampDeg(Number(v[0])), clampDeg(Number(v[1])), clampDeg(Number(v[2]))];
		if (e[0] === 0 && e[1] === 0 && e[2] === 0) continue;
		out[name] = e;
	}
	return out;
}

/** FK：算出全部关节的（人偶本地空间）位置与朝向。模型级平移/旋转/缩放由渲染层再套。 */
export function computeFK(pose: FigurePose): {
	pos: Record<string, Vec3>;
	rot: Record<string, Quat>;
} {
	const pos: Record<string, Vec3> = {};
	const rot: Record<string, Quat> = {};
	for (const j of JOINTS) {
		const local: Quat = j.editable && pose[j.name]
			? qFromEulerDeg(pose[j.name][0], pose[j.name][1], pose[j.name][2])
			: ([...QUAT_IDENTITY] as Quat);
		if (!j.parent) {
			pos[j.name] = [...j.offset] as Vec3;
			rot[j.name] = local;
		} else {
			const pPos = pos[j.parent];
			const pRot = rot[j.parent];
			pos[j.name] = vAdd(pPos, qRotate(pRot, j.offset));
			rot[j.name] = qMul(pRot, local);
		}
	}
	return { pos, rot };
}

/**
 * 拖拽瞄准：把子关节 child 拖向目标点（人偶本地空间）→ 求其父关节应取的本地旋转。
 * 语义=「拖关节转动父骨骼」（姿势编辑器标准手感）。返回 null 表示不可操作
 * （child 无父/父不可编辑/目标与父重合）。丢失捻转（twist）属 v1 已知边界。
 */
export function aimJointAt(
	pose: FigurePose,
	childName: string,
	targetLocal: Vec3,
): { joint: string; euler: [number, number, number] } | null {
	const child = JOINT_BY_NAME[childName];
	if (!child?.parent) return null;
	const parent = JOINT_BY_NAME[child.parent];
	if (!parent?.editable) return null;
	const fk = computeFK(pose);
	const pPos = fk.pos[parent.name];
	// 目标方向换算进「父关节的父」坐标系（父的本地旋转作用前的系）
	const gpRot: Quat = parent.parent ? fk.rot[parent.parent] : ([...QUAT_IDENTITY] as Quat);
	const dirWorld: Vec3 = [targetLocal[0] - pPos[0], targetLocal[1] - pPos[1], targetLocal[2] - pPos[2]];
	if (Math.hypot(...dirWorld) < 1e-6) return null;
	const dirInGp = qRotate(qConj(gpRot), dirWorld);
	const q = qFromTo(vNorm(child.offset), vNorm(dirInGp));
	const euler = eulerDegFromQuat(q);
	return { joint: parent.name, euler };
}

/** 四元数 → 欧拉角（度，XYZ intrinsic；与 qFromEulerDeg 互逆） */
export function eulerDegFromQuat(q: Quat): [number, number, number] {
	const [x, y, z, w] = q;
	// three Euler XYZ 的提取式
	const m11 = 1 - 2 * (y * y + z * z);
	const m12 = 2 * (x * y - z * w);
	const m13 = 2 * (x * z + y * w);
	const m23 = 2 * (y * z - x * w);
	const m33 = 1 - 2 * (x * x + y * y);
	const ry = Math.asin(Math.min(1, Math.max(-1, m13)));
	let rx: number;
	let rz: number;
	if (Math.abs(m13) < 0.9999999) {
		rx = Math.atan2(-m23, m33);
		rz = Math.atan2(-m12, m11);
	} else {
		const m21 = 2 * (x * y + z * w);
		const m22 = 1 - 2 * (x * x + z * z);
		rx = Math.atan2(m21, m22);
		rz = 0;
	}
	const d = 180 / Math.PI;
	return [clampDeg(rx * d), clampDeg(ry * d), clampDeg(rz * d)];
}

/* ───────────────────────── OpenPose 键点映射 ───────────────────────── */

/** OpenPose COCO-18 键点顺序 → 本骨骼关节名 */
export const OPENPOSE_KEYPOINT_JOINTS: string[] = [
	"nose", // 0
	"neck", // 1
	"shoulderR", // 2
	"elbowR", // 3
	"wristR", // 4
	"shoulderL", // 5
	"elbowL", // 6
	"wristL", // 7
	"hipR", // 8
	"kneeR", // 9
	"ankleR", // 10
	"hipL", // 11
	"kneeL", // 12
	"ankleL", // 13
	"eyeR", // 14
	"eyeL", // 15
	"earR", // 16
	"earL", // 17
];

/** 按 FK 结果取 18 键点的人偶本地坐标（渲染层套模型矩阵+投影后交给 openposeDraw） */
export function openposeKeypoints(pose: FigurePose): Vec3[] {
	const fk = computeFK(pose);
	return OPENPOSE_KEYPOINT_JOINTS.map((n) => fk.pos[n]);
}
