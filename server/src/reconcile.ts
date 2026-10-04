import { recoverTextBillingResults } from './store/textBilling.ts';
import { completeTask } from './store/tasks.ts';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import { recoveryWorkers } from './startupRecovery.ts';
import { withinRecoveryWindow } from './recoveryWindow.ts';
import { settleExpiredRequest } from './store/startupExpiry.ts';
/**
 * 启动对账：进程重启会杀掉内存里所有异步任务循环，这里在启动时收拾残局。
 *
 * ① 任务表（tasks.json）里的待办任务：
 *    - 视频且已拿到上游 task_id → 原 taskId 续轮询（不重提交、不重扣费，客户端找回无缝）；
 *    - 其余（文本/图片，或视频尚未提交成功）→ 判失败 + 凭落盘计费信息自动退款，日志收尾。
 * ② 孤儿日志（按天索引里状态还挂着 running、但已无对应在途任务的历史存量）：
 *    - ④段已记录 completed+video_url → 补跑转存救回结果标 success（用户实际拿到产物，不退款）；
 *    - 否则标 failed「服务端重启，任务中断」，按冻结的付款归属和持久流水幂等补偿；
 *      running 日志可能已完成退款但尚未写入终态，不能仅凭日志状态再次退款。
 */
import { listPendingTasks, failTask } from "./store/tasks.ts";
import { finishLog, finishLogsBulk, getRunningLogIds, getLog, getLogMeta, type LogEntry } from "./store/logs.ts";
import { pendingRouteObservationIds, finishRouteObservation } from './routeObservations.ts';
import { refundRequest } from "./store/credits.ts";
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
	// Capture before any await: later user requests must not be swept as startup orphans.
	const routeSnapshot = pendingRouteObservationIds();
  const started = performance.now();
  const recoveryAt = Date.now();
  const pendingSnapshot = listPendingTasks();
  const runningSnapshot = getRunningLogIds();
  const expiredIds = new Set(pendingSnapshot.filter(t => {
    const meta=t.logId ? getLogMeta(t.logId) : undefined;
    return !withinRecoveryWindow(t.submittedAt,recoveryAt) || (meta && !withinRecoveryWindow(meta.startedAt,recoveryAt));
  }).flatMap(t => t.logId ? [t.logId] : []));
  for (const id of runningSnapshot) if (!withinRecoveryWindow(getLogMeta(id)?.startedAt,recoveryAt)) expiredIds.add(id);
  const candidateIds = [...new Set([...runningSnapshot, ...pendingSnapshot.flatMap(t => t.logId && getLogMeta(t.logId)?.status !== 'failed' ? [t.logId] : [])])].filter(id => !expiredIds.has(id));
  info(`[启动对账] 待检查 ${candidateIds.length}，读取工作线程 ${recoveryWorkers(candidateIds.length)}`);
  await yieldToLoop();
  await recoverTextBillingResults(candidateIds, r => {
    if (r.taskId) completeTask(r.taskId, r.result);
    const log = getLog(r.logId);
    if (log?.status === 'running') finishLog(r.logId,{status:'success',response:r.result,taskId:r.taskId});
  });

	// ① 待办任务：能续则续，不能续则失败+退款（failTask 触发退款钩子，billing 已随任务落盘）
	const liveLogs = new Set<string>(); // 续轮询任务的日志仍是合法 running，②不得清扫
	let resumed = 0;
	let aborted = 0;
  let expired = 0;
	for (const rec of pendingSnapshot) {
    if (rec.doneStatus) continue;
		await yieldToLoop();
    const recorded = rec.logId ? getLogMeta(rec.logId) : undefined;
    // logs are durable before the debounced task snapshot. A saved success must
    // never become a failure/refund merely because tasks.json is one write behind.
    if (recorded?.status === 'success' && withinRecoveryWindow(rec.submittedAt, recoveryAt) && !expiredIds.has(rec.logId!)) {
      completeTask(rec.taskId, getLog(rec.logId!)?.response as import('./contract.ts').TaskState['result']);
      continue;
    }
    if (!withinRecoveryWindow(rec.submittedAt,recoveryAt) || (rec.logId && expiredIds.has(rec.logId))) {
      const meta=rec.logId ? getLogMeta(rec.logId) : undefined;
      const b=rec.billing;
      const error=meta && meta.status !== 'running' ? '任务已超时，历史请求已结束，账务未重复处理' : settleExpiredRequest({logId:rec.logId,taskId:rec.taskId,
        userId:b?.userId ?? meta?.userId,payerId:b?.payerId ?? meta?.payerId,
        userWallet:b?.userWallet ?? meta?.userWallet,cost:b?.cost ?? meta?.cost,refunded:b?.refunded,
        agents:b ? [...(b.agents ?? []), ...(b.agentId && b.agentCost ? [{id:b.agentId,cost:b.agentCost}] : [])] : meta?.agentCosts});
      failTask(rec.taskId,error,{accountingHandled:true});
      if (rec.logId && meta?.status === 'running') finishLog(rec.logId,{status:'failed',error,taskId:rec.taskId});
      expired++;continue;
    }
		if (recorded?.status !== 'failed' && resumeVideoPolling(rec)) {
			resumed++;
			if (rec.logId) liveLogs.add(rec.logId);
			continue;
		}
		failTask(rec.taskId, recorded?.error ?? INTERRUPT);
		if (rec.logId) finishLog(rec.logId, { status: "failed", error: rec.error ?? INTERRUPT, taskId: rec.taskId });
		aborted++;
	}

	// ② 孤儿日志：此时仍 running 且不属于续轮询任务的，都已无人认领
	const orphans = runningSnapshot.filter(id => !liveLogs.has(id));
	const patches: ({ id: string } & Parameters<typeof finishLog>[1])[] = [];
	let rescued = 0;
	let refundedTotal = 0;
  for (const id of orphans) {
    await yieldToLoop();
    const meta = getLogMeta(id);
    if (!meta || meta.status !== 'running' || meta.localExecution) continue;
    if (expiredIds.has(id)) {
      const error=settleExpiredRequest({logId:id,taskId:meta.taskId,userId:meta.userId,payerId:meta.payerId,
        userWallet:meta.userWallet,cost:meta.cost,agents:meta.agentCosts});
      finishLog(id,{status:'failed',error});expired++;continue;
    }
    const l = getLog(id);
    if (!l || l.status !== 'running' || l.localExecution) continue;
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
		// 统一退款闸门校验持久流水后原路退回，两侧同退、payerId 归位（存量日志无 payerId → 回退本人）。
		const agentBack = (l.agentCosts ?? []).filter((a) => a.id && a.cost > 0);
		const refund = l.userId && l.cost ? l.cost : 0;
		let error = INTERRUPT;
		if (l.userId && (refund || agentBack.length)) {
			const result = refundRequest({
				reason: "reconcile-refund",
				ref: l.id,
				logId: l.id,
				taskId: l.taskId,
				payerId: l.payerId ?? l.userId,
				statsUserId: l.userId,
				userAmount: refund,
				userWallet: l.userWallet,
				agents: agentBack,
			});
			if (!result.ok) error += `（账务待核对：${result.error}）`;
			else if (result.status === 'settled') error += '（已结算，未重复退款）';
			else if (result.status === 'already-refunded') error += '（已退款）';
			else if (result.status === 'refunded') { refundedTotal += refund; error += `（已退回 ${refund} 积分）`; }
		}
		patches.push({ id: l.id, status: "failed", error });
	}
	finishLogsBulk(patches);
	const liveRouteIds = new Set(listPendingTasks().map(t => t.routing?.observationId ?? t.logId).filter(Boolean));
	for (const id of routeSnapshot) {
		await yieldToLoop();
		if (liveRouteIds.has(id)) continue;
		const log = getLogMeta(id);
		finishRouteObservation(id, log?.status === 'success', log?.error ?? INTERRUPT);
	}

	if (resumed || aborted || patches.length) {
		info(
			`[启动对账] 视频续轮询 ${resumed}，任务中断退款 ${aborted}，孤儿日志清理 ${patches.length}` +
			`（其中救回 ${rescued}${refundedTotal ? `，补退 ${refundedTotal} 积分` : ""}）`,
		);
	}
  info(`[启动对账] 完成，超时收尾 ${expired}，耗时 ${Math.round(performance.now() - started)}ms`);
}
