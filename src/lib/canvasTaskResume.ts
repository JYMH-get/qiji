/**
 * 画布在途任务断连找回的纯逻辑（挑选层）。
 *
 * 背景：画布节点运行态（canvasStore.runtime）是临时态不入库，且任务轮询器（taskCenter）纯内存——
 * 关软件即丢，重开后节点回初始态、完成态永远收不到（服务端任务其实还在：第89轮起任务落盘、终态留 48h）。
 * 修法与资产模式 pendingGens 同款：提交确认时把 {taskId, adapterKey} 持久化进 node.data.task（随项目落盘），
 * 项目加载 / switchCanvas 后凭它重挂轮询接回结果（不重新提交、不再扣费）。
 *
 * 本模块零依赖纯函数：从画布节点里挑出「有持久化任务标记、且本进程尚未在跟踪」的任务清单；
 * 真正的重挂轮询在 pluginRegistry.resumeCanvasNodeTasks。
 */

/** 持久化在 node.data.task 的在途任务凭据（提交确认时写入，服务端给出终态后清除） */
export interface CanvasNodeTask {
	taskId: string;
	adapterKey: string;
	startedAt?: number;
}

export interface ResumableTask {
	nodeId: string;
	taskId: string;
	adapterKey: string;
}

/**
 * 列出可找回的画布在途任务：节点带完整 task 标记（taskId+adapterKey 齐全）且未在 attached 集内
 * （attached=本进程正在跟踪的任务 id——switchCanvas 来回时原轮询仍活着，不重复挂）。
 */
export function listResumableCanvasTasks(
	nodes: Record<string, { id: string; data: { task?: CanvasNodeTask } }>,
	attached: ReadonlySet<string>,
): ResumableTask[] {
	const out: ResumableTask[] = [];
	for (const n of Object.values(nodes)) {
		const t = n.data?.task;
		if (!t?.taskId || !t.adapterKey) continue; // 无标记/字段残缺（旧数据）→ 无从找回，跳过
		if (attached.has(t.taskId)) continue;
		out.push({ nodeId: n.id, taskId: t.taskId, adapterKey: t.adapterKey });
	}
	return out;
}
