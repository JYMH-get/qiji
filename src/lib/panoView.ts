/**
 * panoView —— 720°全景查看/截图的纯参数模型（无 DOM 依赖，可单测）。
 *
 * equirect 全景的视角约定：yaw=水平角（0=正前=全景图水平中央，向右为正，0..360）；
 * pitch=俯仰角（正=抬头看上方、负=低头看下方，±90）；fov=垂直视场角。
 * 四档批量视图（用户定稿）：四视图（前后左右）/ 六视图（+上下）/ 八视图（每45°）/
 * 十二视图（平视前后左右 + 俯视45°前后左右 + 仰视45°前后左右）。
 */

export interface PanoViewDef {
	yaw: number;
	pitch: number;
	fov: number;
	label: string;
}

export type PanoViewSetKind = "four" | "six" | "eight" | "twelve";

const DIR4 = [
	{ yaw: 0, label: "前" },
	{ yaw: 90, label: "右" },
	{ yaw: 180, label: "后" },
	{ yaw: 270, label: "左" },
];

const DIR8 = [
	{ yaw: 0, label: "前" },
	{ yaw: 45, label: "右前" },
	{ yaw: 90, label: "右" },
	{ yaw: 135, label: "右后" },
	{ yaw: 180, label: "后" },
	{ yaw: 225, label: "左后" },
	{ yaw: 270, label: "左" },
	{ yaw: 315, label: "左前" },
];

/** 批量视图定义（四/六视图 fov90 立方体贴脸；八/十二视图 fov60 更接近常规镜头） */
export function viewSet(kind: PanoViewSetKind): PanoViewDef[] {
	switch (kind) {
		case "four":
			return DIR4.map((d) => ({ yaw: d.yaw, pitch: 0, fov: 90, label: d.label }));
		case "six":
			return [
				...DIR4.map((d) => ({ yaw: d.yaw, pitch: 0, fov: 90, label: d.label })),
				{ yaw: 0, pitch: 90, fov: 90, label: "上" },
				{ yaw: 0, pitch: -90, fov: 90, label: "下" },
			];
		case "eight":
			return DIR8.map((d) => ({ yaw: d.yaw, pitch: 0, fov: 60, label: d.label }));
		case "twelve":
			return [
				...DIR4.map((d) => ({ yaw: d.yaw, pitch: 0, fov: 60, label: `${d.label}·平视` })),
				...DIR4.map((d) => ({ yaw: d.yaw, pitch: -45, fov: 60, label: `${d.label}·俯45` })),
				...DIR4.map((d) => ({ yaw: d.yaw, pitch: 45, fov: 60, label: `${d.label}·仰45` })),
			];
	}
}

export const VIEW_SET_LABELS: Record<PanoViewSetKind, string> = {
	four: "四视图",
	six: "六视图",
	eight: "八视图",
	twelve: "十二视图",
};

/** yaw 归一 0..360 */
export function normYaw(yaw: number): number {
	return ((yaw % 360) + 360) % 360;
}

/** 节点是否全景产物（查看器入口判定）：转全景生成的节点带 params.panorama / purpose 标记 */
export function isPanoramaNodeParams(params: Record<string, unknown> | undefined): boolean {
	if (!params) return false;
	return !!params.panorama || params.purpose === "image.panorama";
}
