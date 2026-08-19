/**
 * purposeRunner —— 以 Purpose 为键的统一生成入口（表格按键复用节点执行管线）。
 *
 * 背景（CLAUDE.md §9「两条执行管线待合并」）：
 *   表格生成按键此前各自 `adapter.submit + 自建 30×1s 轮询`，与画布的
 *   `defaultNodeExecute → nodeTaskTracker` 互不复用。
 *
 * 本模块抽出二者共用的底层四步，按 purpose 驱动：
 *   purpose → purposeRegistry(capability/nodeType) → resolveAssetModelKey →
 *   getAdapter → adapter.submit → 通用 TaskTracker 集中轮询
 * 表格侧不需要造画布节点，直接 `await runPurpose(...)` 拿结果即可；
 * 集中轮询复用 services/taskTracker 的同一个 TaskTracker 类（2s 间隔 / 4min 超时 /
 * 网关抖动不立即失败），删掉各 Frame 里重复的 setTimeout 轮询。
 *
 * 后续（阶段3 收尾）：让 nodes/pluginRegistry.defaultNodeExecute 也走本 runner，
 * 使画布与表格真正共用唯一一条提交路径（届时 TaskTracker 由单例统一调度）。
 */

import type { Purpose } from "@/contract";
import { getPurposeMeta } from "@/lib/purposeRegistry";
import { getAdapter } from "./adapters/registry";
import { resolveAssetModelKey } from "./adapters/channelAdapter";
import { trackTask } from "./taskCenter";

export interface RunPurposeInput {
	/** 已合成的提示词正文（表格模式直接给正文；模板化调用可改用 variables/templateId） */
	prompt?: string;
	/** 模板变量（与 prompt 二选一；优先 variables） */
	variables?: Record<string, string>;
	/** catalog 模板 id（正文权威在管理端） */
	templateId?: string;
	/** 输出契约：json + schemaId，则强制结构化 */
	schemaId?: string;
	/** 透传给适配器的额外输入（如变体图生图的底图 imageIds、视频垫素材等） */
	input?: Record<string, unknown>;
	/** 模型参数（temperature / size / duration …） */
	params?: Record<string, unknown>;
	/** 显式指定生效模型 key（画布节点传入已解析的节点模型；省略则按表格解析） */
	modelKey?: string;
	/** 进度回调（0~100 + 四态 + 文本流式部分正文） */
	onProgress?: (progress: number, status: string, partialText?: string) => void;
	/** 提交确认后立即回传 taskId + adapterKey（供断连保护持久化在途任务） */
	onTaskId?: (taskId: string, adapterKey: string) => void;
	/**
	 * 断连找回：凭已有 taskId+adapterKey 直接重挂集中轮询接回结果（**不重新提交、不再扣费**；
	 * 服务端任务落盘且终态保留 48h，见第89轮）。设置后 prompt/params 等提交字段一律忽略；
	 * 适配器缺失/任务过期由轮询层报 failed/lost，调用方按失败处理。
	 */
	resumeTask?: { taskId: string; adapterKey: string };
}

export type RunPurposeResult =
	/** rawLink=true：服务端未转存结果（meta.rehosted=false，resultUri=上游原始时效直链）——
	 *  调用方应本机下载（saveRemoteAsset 带重试）+ uploadBlobToOss 传回服务端落 OSS（第158轮） */
	| { status: "success"; resultUri: string; assetId?: string; rawLink?: boolean; taskId: string; modelKey: string; adapterKey: string }
	/** lost=true：服务端找不到原任务（多因服务端重启）——失败的一种，但可凭 taskId 重连找回，调用方据此提供「重连原任务」 */
	| { status: "failed"; error: string; taskId?: string; modelKey: string; adapterKey?: string; lost?: boolean }
	/** 未配置可用模型（管理端未连/未选模型）——runner 已顺带打开设置引导配置，调用方如实报错即可 */
	| { status: "no_model"; modelKey: string };

/** 用一次性 Promise 包住单例 taskCenter，复用集中轮询而非各自 setTimeout 循环 */
function awaitTask(
	taskId: string,
	adapterKey: string,
	onProgress?: (progress: number, status: string, partialText?: string) => void,
): Promise<{ status: "success" | "failed"; resultUri?: string; assetId?: string; rawLink?: boolean; error?: string; lost?: boolean }> {
	return new Promise((resolve) => {
		trackTask({
			taskId,
			adapterKey,
			onUpdate: (progress, status, resultUri, error, assetId, partialText, rawLink) => {
				onProgress?.(progress, status, partialText);
				if (status === "success") resolve({ status: "success", resultUri, assetId, rawLink });
				else if (status === "failed") resolve({ status: "failed", error });
				// lost：服务端丢任务——作为失败返回，但带 lost 标记供调用方提供「重连原任务」
				else if (status === "lost") resolve({ status: "failed", error, lost: true });
			},
		});
	});
}

/**
 * 执行一个 purpose 的生成，集中轮询直到 success/failed。
 * 返回 no_model 表示当前没有可用的真实适配器（未显式传 modelKey 时已顺带打开「设置 → 管理端」引导连接；
 * 无任何 mock 兜底，调用方如实报错即可）。
 */
export async function runPurpose(
	purpose: Purpose,
	inp: RunPurposeInput = {},
): Promise<RunPurposeResult> {
	// 断连找回：跳过模型解析与提交，直接凭 taskId+adapterKey 重挂集中轮询（不重新提交、不再扣费）
	if (inp.resumeTask) {
		const { taskId, adapterKey } = inp.resumeTask;
		const done = await awaitTask(taskId, adapterKey, inp.onProgress);
		if (done.status === "success") {
			return { status: "success", resultUri: done.resultUri ?? "", assetId: done.assetId, rawLink: done.rawLink, taskId, modelKey: inp.modelKey ?? "", adapterKey };
		}
		return { status: "failed", error: done.error || "生成失败", taskId, modelKey: inp.modelKey ?? "", adapterKey, lost: done.lost };
	}

	const meta = getPurposeMeta(purpose);

	// 客户端不设轮询超时：超时是服务端的职责（服务端对图/视频/文本各有上限，到点置 failed）。
	// 客户端只要任务在跟踪就持续取结果，只认服务端的 success/failed，避免"客户端先超时、
	// 服务端仍在生成并最终落成资产"的错位。

	// 1. 生效模型：优先调用方显式传入（画布节点模型），否则按表格解析；无适配器 → no_model。
	// 无可用模型（非显式传入且解析不到=catalog 无该能力模型）→ 请求不发出，直接打开「设置 → 管理端」引导连接；
	// 显式传入但适配器缺失（如 LibTV/即梦未授权）是另一类错误，不弹设置。
	const modelKey = inp.modelKey ?? resolveAssetModelKey(meta.capability);
	const adapter = getAdapter(modelKey);
	if (!adapter) {
		if (!inp.modelKey) {
			const { useUiStore } = await import("@/store/uiStore");
			useUiStore.getState().openModelSettings();
		}
		return { status: "no_model", modelKey };
	}

	// 2. 组装提交输入：purpose 决定上游模板/schema 路由（managedAdapter 读 input.purpose）
	const submitInput: Record<string, unknown> = {
		purpose,
		_nodeId: `${purpose}-${Date.now()}`,
		...(inp.input || {}),
	};
	if (inp.prompt !== undefined) submitInput.prompt = inp.prompt;
	if (inp.variables) submitInput.variables = inp.variables;
	if (inp.templateId) submitInput.templateId = inp.templateId;
	if (inp.schemaId) submitInput.schemaId = inp.schemaId;

	try {
		inp.onProgress?.(10, "queued");
		const { taskId } = await adapter.submit(submitInput, inp.params ?? {}, meta.nodeType);
		inp.onTaskId?.(taskId, adapter.key);

		// 3. 复用通用 TaskTracker 集中轮询（客户端不超时，直到服务端给出 success/failed）
		const done = await awaitTask(taskId, adapter.key, inp.onProgress);
		if (done.status === "success") {
			return {
				status: "success",
				resultUri: done.resultUri ?? "",
				assetId: done.assetId,
				rawLink: done.rawLink,
				taskId,
				modelKey,
				adapterKey: adapter.key,
			};
		}
		return {
			status: "failed",
			error: done.error || "生成失败",
			taskId,
			modelKey,
			adapterKey: adapter.key,
			lost: done.lost,
		};
	} catch (err) {
		return {
			status: "failed",
			error: err instanceof Error ? err.message : "请求发送失败",
			modelKey,
			adapterKey: adapter.key,
		};
	}
}
