/**
 * rtcPropsTabCore —— 右栏单一窗口三页签（属性/剧本/分镜）的纯逻辑层（零依赖可单测）。
 *
 * 自动切回「属性」规则（用户定稿）：正在「剧本/分镜」页签操作中途不被打断——
 * 只有「新的选中动作」才切：时间轴选中片段（segId 出现/换人）或左栏选中项目资产
 * （assetKey 出现/换人）。同一选中不重复切；取消选中（→null）不切；片段取消后
 * 「露出」既有资产选中也不切（两通道**各自**比较，刻意不做合并签名——合并签名会把
 * 「seg:A → asset:X」的纯取消动作误判成新选中）。
 * 媒体卡（视频/音频预览）选中不参与自动切换——属性页对它没有编辑视图，切过去只会打断用户。
 */

export type RtcPropsTab = "props" | "script" | "shots";

export const PROPS_TABS: readonly { id: RtcPropsTab; label: string }[] = [
	{ id: "props", label: "属性" },
	{ id: "script", label: "剧本" },
	{ id: "shots", label: "分镜" },
];

/** 左栏项目资产选中 → 稳定键（null=无资产选中） */
export function assetSelKey(sel: { cat: string; id: string } | null | undefined): string | null {
	return sel ? `${sel.cat}:${sel.id}` : null;
}

export interface PropsSelSnapshot {
	/** 时间轴当前选中片段 id（无选中/片段已删=null） */
	segId: string | null;
	/** 左栏项目资产选中键（assetSelKey 产物；无=null） */
	assetKey: string | null;
}

/** 「新的选中动作」判定：任一通道出现**新的非空值**才切回「属性」页 */
export function shouldAutoSwitchToProps(prev: PropsSelSnapshot, next: PropsSelSnapshot): boolean {
	return (
		(next.segId !== null && next.segId !== prev.segId) ||
		(next.assetKey !== null && next.assetKey !== prev.assetKey)
	);
}
