/**
 * 启动对账：进程重启会杀掉内存里所有异步任务循环，这里在启动时收拾残局。
 *
 * ① 任务表（tasks.json）里的待办任务：
 *    - 视频且已拿到上游 task_id → 原 taskId 续轮询（不重提交、不重扣费，客户端找回无缝）；
 *    - 其余（文本/图片，或视频尚未提交成功）→ 判失败 + 凭落盘计费信息自动退款，日志收尾。
 * ② 孤儿日志（按天索引里状态还挂着 running、但已无对应在途任务的历史存量）：
 *    - ④段已记录 completed+video_url → 补跑转存救回结果标 success（用户实际拿到产物，不退款）；
 *    - 否则标 failed「服务端重启，任务中断」，并按日志的 userId+cost 退款
 *      （这些是任务表持久化之前的存量——日志还挂 running 说明 finishLog 没跑到，也就从未退过款）。
 */
import { listPendingTasks, failTask } from "./store/tasks.ts";
import { finishLog, finishLogsBulk, getRunningLogs, type LogEntry } from "./store/logs.ts";
import { settle } from "./store/credits.ts";
import { resumeVideoPolling, rehostVideo } from "./translators/index.ts";
import { pickVideoUrl } from "./translators/videos.ts";

const INTERRUPT = "服务端重启，任务中断";

/** 从孤儿日志的④段（上游原始响应）里抠出可救回的视频直链（简梦/openai-video 终态都带 phase 标记） */
function rescuableVideoUrl(l: LogEntry): string {
	if (l.purpose !== "video.generate") return "";
	const r = l.upstreamResponse as { phase?: string; body?: unknown } | undefined;
	if (!r || r.phase !== "completed") return "";
	const url = pickVideoUrl(r.body ?? {});
	return typeof url === "string" && /^https?:\/\//i.test(url) ? url : "";
}

export async function reconcileOnStartup(logger?: { info: (msg: string) => void }): Promise<void> {
	const info = (m: string) => (logger ? logger.info(m) : console.log(m));

	// ① 待办任务：能续则续，不能续则失败+退款（failTask 触发退款钩子，billing 已随任务落盘）
	const liveLogs = new Set<string>(); // 续轮询任务的日志仍是合法 running，②不得清扫
	let resumed = 0;
	let aborted = 0;
	for (const rec of listPendingTasks()) {
		if (resumeVideoPolling(rec)) {
			resumed++;
			if (rec.logId) liveLogs.add(rec.logId);
			continue;
		}
		failTask(rec.taskId, INTERRUPT);
		if (rec.logId) finishLog(rec.logId, { status: "failed", error: INTERRUPT, taskId: rec.taskId });
		aborted++;
	}

	// ② 孤儿日志：此时仍 running 且不属于续轮询任务的，都已无人认领
	const orphans = getRunningLogs().filter((l) => !liveLogs.has(l.id));
	const patches: ({ id: string } & Parameters<typeof finishLog>[1])[] = [];
	let rescued = 0;
	let refundedTotal = 0;
	for (const l of orphans) {
		// 救回：④段已有成品链接 → 转存 OSS 标 success（链接可能已过期，转存失败则照常判失败退款）
		const url = rescuableVideoUrl(l);
		if (url) {
			const re = await rehostVideo(url, { prefix: "video" });
			if (re) {
				patches.push({
					id: l.id,
					status: "success",
					response: { rescued: true, assets: [{ id: re.id, type: "video", url: re.url, meta: { rescued: true } }] },
				});
				rescued++;
				continue;
			}
		}
		// 退款（第183轮修）：旧实现只退用户、且退给 l.userId——
		//  ① 归属链各级渠道商的结算侧扣款从不退 → 渠道商被白扣（与「两侧同进同退」的规矩相悖）；
		//  ② 团队共享积分模式下钱是从团长池扣的，退给团员=团长白亏、团员凭空多出积分。
		// 现在走 credits.settle 一次结算原路退回，两侧同退、payerId 归位（存量日志无 payerId → 回退本人，与旧行为一致）。
		const agentBack = (l.agentCosts ?? []).filter((a) => a.id && a.cost > 0);
		const refund = l.userId && l.cost ? l.cost : 0;
		if (l.userId && (refund || agentBack.length)) {
			settle({
				reason: "reconcile-refund",
				ref: l.id,
				payerId: l.payerId ?? l.userId,
				statsUserId: l.userId,
				userAmount: -refund,
				agents: agentBack.map((a) => ({ id: a.id, cost: -a.cost })),
			});
			refundedTotal += refund;
		}
		patches.push({ id: l.id, status: "failed", error: refund ? `${INTERRUPT}（已退回 ${refund} 积分）` : INTERRUPT });
	}
	finishLogsBulk(patches);

	if (resumed || aborted || patches.length) {
		info(
			`[启动对账] 视频续轮询 ${resumed}，任务中断退款 ${aborted}，孤儿日志清理 ${patches.length}` +
			`（其中救回 ${rescued}${refundedTotal ? `，补退 ${refundedTotal} 积分` : ""}）`,
		);
	}
}
