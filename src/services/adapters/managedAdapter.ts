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
import { nodeTypesForCapability } from "@/nodes/nodeSpecs";
import { checkMaterialLimits } from "@/lib/materialLimits";

/**
 * 能力 → 可服务的画布节点类型（真实 catalog 模型的 nodeTypes 白名单）。
 * 由规范化 NodeSpec 派生，故新增业务节点（如 image.gen）会自动被对应能力的模型服务。
 */
const CAP_TO_NODE_TYPES: Record<Capability, NodeType[]> = {
	text: nodeTypesForCapability("text"),
	image: nodeTypesForCapability("image"),
	video: nodeTypesForCapability("video"),
	audio: nodeTypesForCapability("audio"),
	// 处理类（视频超分/去字幕、图像超分）挂在对应生成节点上（经 params.purpose 覆盖用途）
	"video-enhance": nodeTypesForCapability("video"),
	"video-erase": nodeTypesForCapability("video"),
	"image-enhance": nodeTypesForCapability("image"),
};

/** 能力 → 默认 purpose（caller 可通过 input.purpose 覆盖） */
const CAP_TO_DEFAULT_PURPOSE: Record<Capability, Purpose> = {
	text: "script.analyze",
	image: "asset.character.image",
	video: "video.generate",
	audio: "audio.tts",
	"video-enhance": "video.upscale",
	"video-erase": "video.desub",
	"image-enhance": "image.upscale",
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

			// 素材数量预检（第145轮）：与服务端硬闸同尺——超限请求不发出、明确报错（绝不静默裁剪防 @tag 图例错位）。
			// 表格按键与画布节点共用本 submit（§11.1 唯一请求路径），一处预检覆盖全部提交入口。
			const matErr = checkMaterialLimits(model.label, model.matLimits, req.inputs);
			if (matErr) throw new Error(matErr);

			const { taskId } = await managedClient.generate(req);
			return { taskId };
		},

		async poll(taskId): Promise<PollResult> {
			try {
				const t = await managedClient.getTask(taskId);
				if (t.status === "success") {
					const a0 = t.result?.assets?.[0];
					const uri =
						a0?.url ||
						t.result?.text ||
						(t.result?.json ? JSON.stringify(t.result.json) : "");
					// rehosted=false：服务端下载上游成片失败、结果是原始时效直链 → 标记 rawLink，
					// 由调用方（generationQueue/pluginRegistry）本机下载 + 上传转存 OSS（第158轮）
					return { status: "success", progress: 100, resultUri: uri, assetId: a0?.id, rawLink: a0?.meta?.rehosted === false };
				}
				if (t.status === "failed") {
					return { status: "failed", progress: 100, error: t.error || "生成失败" };
				}
				// 进行中：把服务端流式累积的部分正文透出来（供调用方边收边解析渲染）
				// 第251轮：顺带透出排队位次/阶段文案（服务端自有队列才有；显示走 lib/queueLabel）
				return {
					status: t.status,
					progress: t.progress ?? 50,
					partialText: t.result?.text,
					queuePosition: t.queuePosition,
					queueTotal: t.queueTotal,
					stageText: t.stageText,
				};
			} catch (err) {
				// 服务端可达但任务不存在（404，多因服务端重启丢了内存任务）→ 标记 lost：
				// 终态、提示「服务端异常」，可凭原 taskId 重连找回（不重新生成、不再扣费）。
				if ((err as { status?: number }).status === 404) {
					return { status: "lost", progress: 100, error: "服务端异常：未找到原任务（服务端可能已重启）。可重连原任务找回结果。" };
				}
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
