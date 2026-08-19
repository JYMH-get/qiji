/**
 * viewAngle —— 「转视角」的**UI 参数模型**（无 DOM 依赖，可单测）。
 *
 * ⚠ 第193轮起本文件**不含任何提示词文案**（用户要求提示词对客户端不可见）：
 * 客户端只携带机位参数（params.viewAngle）提交，提示词由服务端按 purpose "image.viewangle"
 * 渲染（server/src/translators/viewAnglePrompt.ts + 管理端「提示词模板」分类「转视角」）。
 * 这里只剩取景器 UI 需要的参数定义、档位换算与预设。
 */

export interface ViewAngleParams {
	/** 水平环绕 0..359：0=正面，向右为正（90=正右侧、180=背面、270=正左侧） */
	az: number;
	/** 垂直俯仰 -90..90：正=俯视（高机位向下拍）、负=仰视（低机位向上拍）、0=平视 */
	el: number;
	/** 景别档 0..4：特写/近景/中景/全景/远景（取景器滚轮=等效相机距离，换算见 shotFromScale） */
	shot: number;
	/** 镜头特效（预设用）：鱼眼畸变 / 荷兰角倾斜 */
	lens?: "fisheye" | "dutch";
	/** 相机平移取景（WASD）：占画面宽/高的百分比，右/下为正；缺省 0=居中 */
	panX?: number;
	panY?: number;
}

export const SHOT_LABELS = ["特写", "近景", "中景", "全景", "远景"] as const;

export const DEFAULT_VIEW: ViewAngleParams = { az: 0, el: 0, shot: 2 };

/** 滑杆吸附步长（度）：降低连续角度的语言歧义，服务端句式对整档描述最稳 */
export const ANGLE_STEP = 15;

/** 取景器缩放（等效相机距离）↔ 景别档换算：图像放大=距离近=景别紧 */
export function shotFromScale(scale: number): number {
	if (scale >= 1.55) return 0; // 特写
	if (scale >= 1.2) return 1;  // 近景
	if (scale >= 0.85) return 2; // 中景
	if (scale >= 0.6) return 3;  // 全景
	return 4;                    // 远景
}
export const SHOT_SCALES = [1.7, 1.35, 1, 0.7, 0.5] as const;

/** 预设（对齐参考 UI：鱼眼/倾斜/正面俯拍/正面仰拍/全景俯拍/背面视角） */
export const VIEW_PRESETS: { id: string; label: string; params: ViewAngleParams }[] = [
	{ id: "fisheye", label: "鱼眼视角", params: { az: 0, el: 0, shot: 1, lens: "fisheye" } },
	{ id: "dutch", label: "倾斜视角", params: { az: 30, el: 0, shot: 2, lens: "dutch" } },
	{ id: "front-high", label: "正面俯拍", params: { az: 0, el: 45, shot: 2 } },
	{ id: "front-low", label: "正面仰拍", params: { az: 0, el: -45, shot: 2 } },
	{ id: "bird", label: "全景俯拍", params: { az: 0, el: 75, shot: 4 } },
	{ id: "back", label: "背面视角", params: { az: 180, el: 0, shot: 2 } },
];
