/**
 * vecmath —— 骨骼层用的最小三维数学件（纯函数，零依赖）。
 *
 * 刻意不用 three：骨骼 FK/姿势序列化是纯逻辑层（vitest 直测），three 只进
 * 懒加载的渲染层（modelStage）。约定右手系：+X 人物左侧、+Y 上、+Z 面向方向。
 */

export type Vec3 = [number, number, number];
/** 四元数 [x, y, z, w] */
export type Quat = [number, number, number, number];

export const QUAT_IDENTITY: Quat = [0, 0, 0, 1];

export function vAdd(a: Vec3, b: Vec3): Vec3 {
	return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function vSub(a: Vec3, b: Vec3): Vec3 {
	return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function vScale(a: Vec3, s: number): Vec3 {
	return [a[0] * s, a[1] * s, a[2] * s];
}

export function vLen(a: Vec3): number {
	return Math.hypot(a[0], a[1], a[2]);
}

export function vNorm(a: Vec3): Vec3 {
	const l = vLen(a);
	return l < 1e-9 ? [0, 0, 0] : [a[0] / l, a[1] / l, a[2] / l];
}

export function vCross(a: Vec3, b: Vec3): Vec3 {
	return [
		a[1] * b[2] - a[2] * b[1],
		a[2] * b[0] - a[0] * b[2],
		a[0] * b[1] - a[1] * b[0],
	];
}

export function vDot(a: Vec3, b: Vec3): number {
	return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function qMul(a: Quat, b: Quat): Quat {
	const [ax, ay, az, aw] = a;
	const [bx, by, bz, bw] = b;
	return [
		aw * bx + ax * bw + ay * bz - az * by,
		aw * by - ax * bz + ay * bw + az * bx,
		aw * bz + ax * by - ay * bx + az * bw,
		aw * bw - ax * bx - ay * by - az * bz,
	];
}

export function qNorm(q: Quat): Quat {
	const l = Math.hypot(q[0], q[1], q[2], q[3]);
	return l < 1e-9 ? [...QUAT_IDENTITY] as Quat : [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

/** 用四元数旋转向量 */
export function qRotate(q: Quat, v: Vec3): Vec3 {
	// v' = q * (v,0) * q^-1 的展开式
	const [qx, qy, qz, qw] = q;
	const [vx, vy, vz] = v;
	const tx = 2 * (qy * vz - qz * vy);
	const ty = 2 * (qz * vx - qx * vz);
	const tz = 2 * (qx * vy - qy * vx);
	return [
		vx + qw * tx + qy * tz - qz * ty,
		vy + qw * ty + qz * tx - qx * tz,
		vz + qw * tz + qx * ty - qy * tx,
	];
}

export function qConj(q: Quat): Quat {
	return [-q[0], -q[1], -q[2], q[3]];
}

/** 欧拉角（度，XYZ 顺序，intrinsic）→ 四元数——与 three 的 Euler "XYZ" 一致 */
export function qFromEulerDeg(rx: number, ry: number, rz: number): Quat {
	const hx = (rx * Math.PI) / 360;
	const hy = (ry * Math.PI) / 360;
	const hz = (rz * Math.PI) / 360;
	const cx = Math.cos(hx), sx = Math.sin(hx);
	const cy = Math.cos(hy), sy = Math.sin(hy);
	const cz = Math.cos(hz), sz = Math.sin(hz);
	return [
		sx * cy * cz + cx * sy * sz,
		cx * sy * cz - sx * cy * sz,
		cx * cy * sz + sx * sy * cz,
		cx * cy * cz - sx * sy * sz,
	];
}

/** 从单位向量 from 转到单位向量 to 的最短旋转 */
export function qFromTo(from: Vec3, to: Vec3): Quat {
	const f = vNorm(from);
	const t = vNorm(to);
	const d = vDot(f, t);
	if (d > 1 - 1e-9) return [...QUAT_IDENTITY] as Quat;
	if (d < -1 + 1e-9) {
		// 反向：取任一与 f 垂直的轴转 180°
		let axis = vCross([1, 0, 0], f);
		if (vLen(axis) < 1e-6) axis = vCross([0, 1, 0], f);
		const [x, y, z] = vNorm(axis);
		return [x, y, z, 0];
	}
	const axis = vCross(f, t);
	const q: Quat = [axis[0], axis[1], axis[2], 1 + d];
	return qNorm(q);
}
