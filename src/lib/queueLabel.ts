/**
 * 排队提示与耗时文案（第251轮）——两个纯函数，画布节点/属性面板/请求记录三处共用一把尺。
 *
 * 背景：奇迹云（服务端自有实例池）派单前任务会在服务端队列里排队，用户视角只看到「一直转圈」。
 * 服务端在轮询回执里带上 queuePosition/queueTotal（排队中）与 queuedMs（派单后定格），
 * 客户端据此把在途文案切成「排队中 · 第 3/8 位」、把请求记录耗时拆成「实际生成（排队）」。
 *
 * ⚠ 口径（勿改）：`durationMs` 恒是整段墙钟（提交→终态，含排队），实际生成 = durationMs - queuedMs。
 * 服务端不预减——旧记录没有 queuedMs 时才能自然退化成原来的单值耗时。
 */

/** 在途任务的进度/阶段文案来源（TaskState / NodeRuntime 的同名字段） */
export interface QueueExtra {
	/** 排队位次（1 基）；有值即认定「排队中」，优先级最高 */
	queuePosition?: number;
	/** 同队总数（与位次配对显示「第 3/8 位」；缺省只显示位次） */
	queueTotal?: number;
	/** 服务端阶段文案（通用通道）：无位次时直接顶替「生成中 X%」 */
	stageText?: string;
}

/**
 * 在途任务的进度文案。
 * 优先级：排队位次 > 阶段文案 > 生成中 X%。
 */
export function progressLabel(progress: number | null | undefined, extra?: QueueExtra): string {
	const pos = extra?.queuePosition;
	if (typeof pos === "number" && Number.isFinite(pos) && pos > 0) {
		const total = extra?.queueTotal;
		const hasTotal = typeof total === "number" && Number.isFinite(total) && total >= pos;
		return hasTotal ? `排队中 · 第 ${Math.round(pos)}/${Math.round(total)} 位` : `排队中 · 第 ${Math.round(pos)} 位`;
	}
	const stage = extra?.stageText?.trim();
	if (stage) return stage;
	// ⚠ 无进度数据（提交后到首次轮询之间、重启后重挂轮询之前）显示「生成中…」不带百分比——
	//   硬凑成「生成中 0%」比改造前的「生成中」还难看，且 0% 会被误读成卡住了。
	if (typeof progress !== "number" || !Number.isFinite(progress)) return "生成中…";
	return `生成中 ${Math.max(0, Math.round(progress))}%`;
}

/**
 * 请求记录耗时文案：
 *  - 有排队 → 「365s（956s）」= 实际生成（排队），两值均按秒取整；
 *  - 无排队 → 「365.0s」（与改造前口径一致）；
 *  - 无数据 → 「—」。
 */
export function formatDurationWithQueue(durationMs?: number | null, queuedMs?: number | null): string {
	const dur = typeof durationMs === "number" && Number.isFinite(durationMs) ? durationMs : null;
	if (dur === null) return "—";
	const queued = typeof queuedMs === "number" && Number.isFinite(queuedMs) && queuedMs > 0 ? queuedMs : 0;
	if (!queued) return `${(dur / 1000).toFixed(1)}s`;
	const actual = Math.max(0, dur - queued);
	return `${Math.round(actual / 1000)}s（${Math.round(queued / 1000)}s）`;
}
