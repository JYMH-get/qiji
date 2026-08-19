/**
 * jyTransitions —— 剪映内置转场资源表（effect_id / resource_id）。
 *
 * 数据来源：pyJianYingDraft `metadata/transition_meta.py`（TransitionMeta 枚举），参数顺序已核
 * `metadata/effect_meta.py`：`TransitionMeta(name, is_vip, resource_id, effect_id, md5, 默认时长秒, is_overlap)`
 * ——**resource_id 是 19 位长数字串、effect_id 是短数字串**，与真实剪映草稿里
 * materials.transitions 条目的字段一致（勿对调；对调后剪映找不到资源、转场静默失效）。
 *
 * 这里只搬**免费**的常用转场（18 条）；要扩充照抄 transition_meta.py 对应行即可。
 * is_overlap 随导出条目原样写出（叠化类=前后段重叠过渡 true、闪黑闪白类=不重叠 false）。
 */

/** 转场预览样式（播放器按此渲染真预览）：dissolve=交叉淡化、flash=色闪、slide*=双画面推挤 */
export type JyPreviewKind = "dissolve" | "flashblack" | "flashwhite" | "slideleft" | "slideright" | "slideup" | "slidedown";

export interface JyTransitionMeta {
	/** 展示名（与剪映一致） */
	name: string;
	/** 剪映 effect_id（短数字串） */
	effectId: string;
	/** 剪映 resource_id（长数字串） */
	resourceId: string;
	/** 剪映默认时长（微秒） */
	defaultDurationUs: number;
	/** 是否与相邻片段重叠过渡（导出条目的 is_overlap） */
	isOverlap: boolean;
	/** 预览样式（缺省=无法在我们播放器里做出一致预览 → **不进选择器**，见 JY_PREVIEW_TRANSITIONS） */
	previewKind?: JyPreviewKind;
}

const T = (name: string, resourceId: string, effectId: string, durMs: number, isOverlap: boolean, previewKind?: JyPreviewKind): JyTransitionMeta => ({
	name,
	effectId,
	resourceId,
	defaultDurationUs: durMs * 1000,
	isOverlap,
	...(previewKind ? { previewKind } : {}),
});

/**
 * 剪映内置转场资源表（顺序即 UI 下拉顺序：柔和过渡在前、运动在后）。
 * ⚠ 用户定稿（勿回退）：**没有预览的转场不上 UI**——「不预览直接导出到剪映效果不一致，还不如没有」。
 * 带 previewKind 的款式播放器有真预览（观感与剪映一致的基础转场）；无 previewKind 的花式款
 * （溶解噪点/雾化/遮罩/马赛克/震动等做不出一致预览）保留在表里只为**旧文档导出兼容**，不进选择器。
 */
export const JY_TRANSITIONS: readonly JyTransitionMeta[] = [
	T("叠化", "6724845717472416269", "322577", 500, true, "dissolve"),
	T("闪黑", "6724239388189921806", "321493", 500, false, "flashblack"),
	T("闪白", "6724845376098013708", "322575", 500, false, "flashwhite"),
	T("色彩溶解", "6724846004274729480", "322583", 500, true),
	T("叠加", "6914112332205396488", "1003369", 1000, true),
	T("模糊", "6911569618171597320", "4212596", 500, true),
	T("雾化", "7216171159589491259", "11387229", 1200, true),
	T("推近", "6724226861666144779", "359359", 1000, false),
	T("拉远", "6724226338418332167", "359365", 1000, false),
	T("向左", "6724227717195108867", "359529", 500, false),
	T("向右", "6724227599616184836", "359527", 1000, false),
	T("左移", "6726711499676455435", "2917286", 1000, true, "slideleft"),
	T("右移", "6726711296063967748", "2917287", 1000, true, "slideright"),
	T("上移", "6724846395116753416", "2917279", 500, true, "slideup"),
	T("下移", "6724849276100284942", "2917280", 500, true, "slidedown"),
	T("圆形遮罩", "6725767129519362573", "2916676", 500, true),
	T("马赛克", "6724866519022440967", "4212631", 1000, true),
	T("震动", "7198100561235808825", "9261771", 1000, true),
] as const;

/** 可选转场清单（选择器/转场页用）＝只有带真预览的款式（所见即所得红线） */
export const JY_PREVIEW_TRANSITIONS: readonly JyTransitionMeta[] = JY_TRANSITIONS.filter((t) => t.previewKind);

/** 按 effect_id 查资源表条目（导出取 is_overlap 用；查不到=非表内资源，is_overlap 按 true 兜底） */
export function findJyTransition(effectId: string): JyTransitionMeta | undefined {
	return JY_TRANSITIONS.find((t) => t.effectId === effectId);
}

/** 转场时长夹取（0.1s–5s；非法回退该资源默认时长 / 0.5s） */
export function clampTransitionUs(us: unknown, effectId?: string): number {
	const n = Number(us);
	if (Number.isFinite(n) && n > 0) return Math.min(5_000_000, Math.max(100_000, Math.round(n)));
	return (effectId && findJyTransition(effectId)?.defaultDurationUs) || 500_000;
}
