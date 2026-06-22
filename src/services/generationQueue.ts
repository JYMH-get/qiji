/**
 * generationQueue —— 资产出图的断连保护层。
 *
 * 问题：此前 AssetWorkbench 直接 `await runPurpose` 后写结果，绑定只活在组件闭包 +
 * 内存轮询器里；切页/关软件即丢（管理端已完成、用户端没接到）。
 *
 * 方案：把「在途生成」持久化到项目（projectStore.pendingGens，随项目落盘）：
 *  - 提交即登记 pending（含原始请求，供重试）+ 显示持久占位；
 *  - 完成回调走**全局 store**（与当前在哪个页面无关）→ 落资产 + 清 pending；
 *  - 失败 → 标红保留，供「重试」按原请求重发；
 *  - App 启动 `resumePendingGenerations()`：对带 taskId 的 running 在途**重新挂轮询**
 *    （服务端 task 仍在即可接回）；没拿到 taskId 就断的 → 标失败可重试。
 */
import type { Purpose } from "@/contract";
import { useProjectStore, type AssetCat } from "@/store/projectStore";
import type { PendingGen } from "@/services/projectFile";
import { runPurpose } from "./purposeRunner";
import { trackTask } from "./taskCenter";
import { saveRemoteAsset } from "./assetPersist";

export interface GenSpec {
	cat: AssetCat;
	assetId: string;
	variantId: string | null;
	purpose: Purpose;
	prompt: string;
	params?: Record<string, unknown>;
	/** 生效模型 key（来自界面模型选择器）；空=按设置默认解析 */
	modelKey?: string;
	/** 额外输入（图生图垫图 images:[{url}] 等） */
	input?: Record<string, unknown>;
	label: string;
}

let _seq = 0;
const uid = () => `gen-${Date.now()}-${++_seq}`;

/**
 * 结果落地：成功写资产 + 清 pending；失败标红保留。仅当该 pending 仍属当前项目时生效（防切项目串写）。
 * 成功时（Tauri）把原件下载到本地、登记三元映射（assetId/url/localPath），界面图改走本地 uri 秒级加载。
 */
async function applyResult(id: string, status: "success" | "failed", resultUri?: string, error?: string, assetId?: string): Promise<void> {
	const st = useProjectStore.getState();
	const p = st.pendingGens.find((x) => x.id === id);
	if (!p) return; // 已切换项目/已被清除 → 丢弃（原项目重开时会续跑）
	if (status === "success" && resultUri) {
		// 本地落盘 + 三元映射；失败/非 Tauri 退回直接用 url
		let displayUri = resultUri;
		try {
			const blob = await saveRemoteAsset(assetId || `local-${id}`, resultUri);
			if (blob) {
				st.registerAssetBlob(blob);
				displayUri = blob.localUri || resultUri;
			}
		} catch { /* 落盘失败：用 url 兜底 */ }
		// 重新取最新状态（落盘是异步，期间可能变化）
		if (!useProjectStore.getState().pendingGens.find((x) => x.id === id)) return;
		useProjectStore.getState().addAssetImage(p.cat, p.assetId, p.variantId, displayUri, true);
		useProjectStore.getState().removePendingGen(id);
	} else {
		st.updatePendingGen(id, { status: "failed", error: error || "生成失败" });
	}
	void useProjectStore.getState().save(true);
}

/** 提交一次生成（异步，不阻塞调用方）；UI 由 pendingGens 持久占位驱动。 */
export function startGeneration(spec: GenSpec): void {
	const st = useProjectStore.getState();
	const id = uid();
	const pending: PendingGen = {
		id,
		cat: spec.cat,
		assetId: spec.assetId,
		variantId: spec.variantId,
		purpose: spec.purpose,
		prompt: spec.prompt,
		params: spec.params,
		modelKey: spec.modelKey,
		input: spec.input,
		label: spec.label,
		status: "running",
		createdAt: Date.now(),
	};
	st.addPendingGen(pending);
	void st.save(true);
	runIt(id, spec);
}

/** 重试：按原始请求重发（复用同一条 pending） */
export function retryGeneration(id: string): void {
	const st = useProjectStore.getState();
	const p = st.pendingGens.find((x) => x.id === id);
	if (!p) return;
	st.updatePendingGen(id, { status: "running", error: undefined, taskId: undefined, adapterKey: undefined });
	void st.save(true);
	runIt(id, { cat: p.cat, assetId: p.assetId, variantId: p.variantId, purpose: p.purpose as Purpose, prompt: p.prompt, params: p.params, modelKey: p.modelKey, input: p.input, label: p.label });
}

function runIt(id: string, spec: GenSpec): void {
	runPurpose(spec.purpose, {
		prompt: spec.prompt,
		params: spec.params,
		modelKey: spec.modelKey || undefined,
		input: spec.input,
		onTaskId: (taskId, adapterKey) => {
			useProjectStore.getState().updatePendingGen(id, { taskId, adapterKey });
			void useProjectStore.getState().save(true);
		},
	})
		.then((run) => {
			if (run.status === "success") void applyResult(id, "success", run.resultUri, undefined, run.assetId);
			else if (run.status === "no_model") void applyResult(id, "failed", undefined, "未配置可用的图像模型，请先在「设置 → 模型」中选择后重试。");
			else void applyResult(id, "failed", undefined, run.error);
		})
		.catch((err) => void applyResult(id, "failed", undefined, err instanceof Error ? err.message : "生成失败"));
}

/** App 启动调用：把上次未完成的在途任务接回来。 */
export function resumePendingGenerations(): void {
	const st = useProjectStore.getState();
	for (const p of st.pendingGens) {
		if (p.status !== "running") continue;
		if (p.taskId && p.adapterKey) {
			// 服务端 task 仍在 → 重新挂轮询，结果照常落地
			trackTask({
				taskId: p.taskId,
				adapterKey: p.adapterKey,
				onUpdate: (_progress, status, resultUri, error, assetId) => {
					if (status === "success") void applyResult(p.id, "success", resultUri, undefined, assetId);
					else if (status === "failed") void applyResult(p.id, "failed", undefined, error);
				},
			});
		} else {
			// 提交未确认就断了 → 无法恢复，标失败可重试
			st.updatePendingGen(p.id, { status: "failed", error: "上次未完成（提交未确认），可重试" });
		}
	}
	void st.save(true);
}
