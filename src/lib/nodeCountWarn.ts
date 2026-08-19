/**
 * nodeCountWarn —— 画布节点数量预警的纯逻辑（第146轮，用户定档）。
 * 阈值序列：350、450、500、550，550 之后每 10 一档（560、570…）。
 * 语义：仅提示不拦截——节点过多会导致画布卡顿、保存变慢甚至写盘中断损坏项目文件
 * （「三姐妹」161MB 截断事故同类风险，见 §7.1/第80轮）。
 */

/** count 所处的最高已达阈值；未达 350 返回 null */
export function nodeCountThreshold(count: number): number | null {
	if (count >= 550) return 550 + Math.floor((count - 550) / 10) * 10;
	if (count >= 500) return 500;
	if (count >= 450) return 450;
	if (count >= 350) return 350;
	return null;
}

/**
 * 预警状态推进：last=上次已提醒的阈值（0=未提醒过）。
 * 越过新阈值（t > last）→ 提醒一次并记住；回落（t < last，删节点/切画布）→ 同步回落，
 * 再次越过同一阈值会重新提醒；驻留同档不重复提醒。
 */
export function advanceWarn(last: number, count: number): { warnAt: number | null; last: number } {
	const t = nodeCountThreshold(count) ?? 0;
	if (t > last) return { warnAt: t, last: t };
	return { warnAt: null, last: t };
}
