/**
 * rtcCenterTabCore —— 中栏双页签（AI 工作台 / 预览）的纯逻辑层（零依赖可单测）。
 *
 * 自动切换规则（用户定稿「中间预览栏分页，作为 AI 工作台和预览窗口双模式」，五条）：
 *  1) **新选中**任何「占位符」片段（第240轮扩展：分镜占位符 placeholder+shotRef 与
 *     无 shotRef 的**自由结果占位**都算——两者的编辑正文都在工作台，见 RtcShotAiWorkbench /
 *     RtcFreeGenWorkbench）→ 切「AI 工作台」；同一选中不重复切、取消选中不切（与 rtcPropsTabCore 同语义）；
 *  2) **新选中**左栏素材/资产卡预览（rtcAssetSelStore 的 selected / mediaSel，两通道**各自**比较，
 *     刻意不做合并签名——合并会把「取消其一露出另一」误判成新选中）→ 切「预览」；
 *  3) 选中片段 **placeholder→media（同 segId）**（生成成功占位符被原位替换，placeholderSwap 保 id；
 *     分镜占位与自由占位同规——判定只看 kind 变化，不看 shotRef）→ 切「预览」（成片即看）；
 *  4) 初始页签 = doc 已有任何可播片段（media/compound）? 「预览」:「AI 工作台」
 *     （用户定「当没有结果时默认显示 AI 工作台」；会话级不持久化，见 rtcCenterTabStore）；
 *  5) 手动点页签永远生效，手动后仍接受后续自动信号（判定只看「新选中动作」，无手动锁）。
 */

export type RtcCenterTab = "workbench" | "preview";

export const CENTER_TABS: readonly { id: RtcCenterTab; label: string }[] = [
	{ id: "workbench", label: "AI 工作台" },
	{ id: "preview", label: "预览" },
];

/** 规则 4：初始页签（docHasPlayable = doc 是否已有任何 media/compound 片段——有可预览的内容才默认预览） */
export function initialCenterTab(docHasPlayable: boolean): RtcCenterTab {
	return docHasPlayable ? "preview" : "workbench";
}

export interface CenterSelSnapshot {
	/** 时间轴当前选中片段 id（无选中/片段已删=null） */
	segId: string | null;
	/** 选中片段 kind（无选中=null；规则 1「新选中占位符」与规则 3「placeholder→media」判定用） */
	segKind: string | null;
	/** 左栏项目资产选中键（cat:id；无=null） */
	assetKey: string | null;
	/** 左栏媒体卡选中键（素材页 视频/音频/图片 卡；无=null） */
	mediaKey: string | null;
}

/**
 * 自动切换判定：返回要切到的页签，null=不动。
 * 规则 3 最先判——同 segId 的 kind 变化不是「新选中」，与规则 1 天然互斥不打架；
 * 规则 1（占位符→工作台）优先于规则 2（素材预览）——同拍出现两个新选中时以时间轴片段为准。
 */
export function centerTabAutoSwitch(prev: CenterSelSnapshot, next: CenterSelSnapshot): RtcCenterTab | null {
	// 规则 3：同一片段 placeholder→media（成片原位替换占位符）→ 预览
	if (next.segId !== null && next.segId === prev.segId && prev.segKind === "placeholder" && next.segKind === "media") {
		return "preview";
	}
	// 规则 1：新选中占位符（分镜占位/自由结果占位一视同仁）→ AI 工作台（同一选中不重复切；取消选中不切）
	if (next.segKind === "placeholder" && next.segId !== null && next.segId !== prev.segId) return "workbench";
	// 规则 2：新选中左栏素材/资产预览 → 预览（两通道各自比较）
	if (
		(next.assetKey !== null && next.assetKey !== prev.assetKey) ||
		(next.mediaKey !== null && next.mediaKey !== prev.mediaKey)
	) {
		return "preview";
	}
	return null;
}
