/**
 * managedAdapter —— 唯一的模型适配器。
 *
 * 取代旧的 channelAdapter(vendor分支) / seedance / gvlm* / libImage / libAudio。
 * catalog 里的每个模型注册成一个 ManagedAdapter，但底层统一走 managedClient → 管理端。
 * 沿用现有 ModelAdapter { submit, poll } 契约，无缝接入现有 registry 与节点执行路径。
 */

import type { NodeType } from "@/types";
import type { ModelAdapter, CapabilityMode, SubmitResult, PollResult, ParamField as AdapterParamField } from "./types";
import { registerAdapter, listAdapters } from "./registry";
import type { Capability, CatalogModel, GenerateRequest, Purpose, AssetRef } from "@/contract";
import { managedClient } from "@/services/managedClient";
import { useCatalogStore } from "@/store/catalogStore";

const CAP_TO_NODE_TYPES: Record<Capability, NodeType[]> = {
	text: ["text", "script"],
	image: ["image"],
	video: ["video"],
	audio: ["audio"],
};

/** 能力 → 默认 purpose（caller 可通过 input.purpose 覆盖） */
const CAP_TO_DEFAULT_PURPOSE: Record<Capability, Purpose> = {
	text: "script.analyze",
	image: "asset.character.image",
	video: "video.generate",
	audio: "audio.tts",
};

function buildModes(model: CatalogModel): CapabilityMode[] {
	return [
		{
			key: model.id,
			label: model.label,
			inputHint: "根据提示词生成...",
			paramsSchema: (model.params ?? []) as AdapterParamField[],
		},
	];
}

/** 把 input 里的素材整理成协议 AssetRef 分组 */
function collectInputs(input: Record<string, unknown>): GenerateRequest["inputs"] {
	// 优先用调用方已组织好的 inputs
	if (input.inputs) return input.inputs as GenerateRequest["inputs"];
	const toRefs = (v: unknown): AssetRef[] =>
		Array.isArray(v) ? v.map((x) => (typeof x === "string" ? { id: x } : (x as AssetRef))) : [];
	const out: GenerateRequest["inputs"] = {};
	if (input.imageIds || input.images) out.images = toRefs(input.images ?? input.imageIds);
	if (input.videoIds || input.videos) out.videos = toRefs(input.videos ?? input.videoIds);
	if (input.audioIds || input.audios) out.audios = toRefs(input.audios ?? input.audioIds);
	return Object.keys(out).length ? out : undefined;
}

export function buildManagedAdapter(model: CatalogModel): ModelAdapter {
	return {
		key: model.id,
		displayName: model.label,
		vendor: "管理端",
		nodeTypes: CAP_TO_NODE_TYPES[model.capability],
		modes: buildModes(model),
		baseCost: model.cost ?? 10,
		estimateCost: () => model.cost ?? 10,

		async submit(input, params, _nodeType): Promise<SubmitResult> {
			// 用户端尚无独立的项目 id 概念，暂以存档路径/项目名作为隔离键（阶段2 由管理端分配后替换）
			const ps = (await import("@/store/projectStore")).useProjectStore.getState();
			const projectId = (input.projectId as string) || ps.savePath || ps.name || "";

			const purpose =
				(input.purpose as Purpose) || CAP_TO_DEFAULT_PURPOSE[model.capability];

			// variables：模板化调用传 variables；自由提示词把 prompt 当变量
			const variables =
				(input.variables as Record<string, string>) ||
				(input.prompt ? { prompt: String(input.prompt) } : undefined);

			const req: GenerateRequest = {
				purpose,
				model: model.id,
				templateId: (input.templateId as string) || (params.template as string) || undefined,
				variables,
				inputs: collectInputs(input),
				params,
				output: (input.output as GenerateRequest["output"]) || {
					format: input.schemaId ? "json" : model.capability === "text" ? "text" : "asset",
					schemaId: input.schemaId as string | undefined,
				},
				promptOverride: input.promptOverride as string | undefined,
				clientTaskId:
					(input.clientTaskId as string) ||
					(typeof crypto !== "undefined" && crypto.randomUUID
						? crypto.randomUUID()
						: `c-${Date.now()}-${Math.random().toString(36).slice(2)}`),
				scheduledAt: input.scheduledAt as string | undefined,
				projectId,
			};

			const { taskId } = await managedClient.generate(req);
			return { taskId };
		},

		async poll(taskId): Promise<PollResult> {
			try {
				const t = await managedClient.getTask(taskId);
				if (t.status === "success") {
					const uri =
						t.result?.assets?.[0]?.url ||
						t.result?.text ||
						(t.result?.json ? JSON.stringify(t.result.json) : "");
					return { status: "success", progress: 100, resultUri: uri, assetId: t.result?.assets?.[0]?.id };
				}
				if (t.status === "failed") {
					return { status: "failed", progress: 100, error: t.error || "生成失败" };
				}
				// 进行中：把服务端流式累积的部分正文透出来（供调用方边收边解析渲染）
				return { status: t.status, progress: t.progress ?? 50, partialText: t.result?.text };
			} catch (err) {
				// 网关 5xx / 网络抖动：当作仍在进行，让上层继续轮询
				return { status: "running", progress: 50, error: (err as Error).message };
			}
		},
	};
}

/**
 * 按 catalog 模型同步注册所有 ManagedAdapter。
 * 在启动拉取 catalog 后、以及 catalog 更新后调用（catalogStore.syncCatalog 已自动调用）。
 */
export function syncManagedAdapters(): void {
	const models = useCatalogStore.getState().models();
	const existing = new Set(listAdapters().map((a) => a.key));
	for (const m of models) {
		// 重复注册即覆盖，保证模型参数随 catalog 更新
		registerAdapter(buildManagedAdapter(m));
		existing.delete(m.id);
	}
	// 说明：本阶段不主动注销已下架模型的 adapter（registry 无 remove）；
	// 阶段2 给 registry 增加 unregister 后再清理 existing 中残留的 key。
}
