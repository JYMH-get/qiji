import { useCanvasStore } from "@/store/canvasStore";
import { useCatalogStore } from "@/store/catalogStore";
import { useLibraryStore } from "@/store/libraryStore";
import { getNodeMaterialItems } from "@/canvas/nodeMaterials";
import { getPlugin } from "@/nodes/pluginRegistry";
import { resolveActiveModelKey } from "@/services/adapters/channelAdapter";
import { isNodeRunBusy, isRunnableNode } from "@/command/nodeRunEligibility";
import { buildImageParams, imageResolutionOptions } from "@/lib/genParams";
import { clampDurationTo, clampMethod, clampToOptions, modelMethods, videoReqOptions } from "@/lib/videoMethods";
import type { GenerationCostRequest } from "@/lib/generationCost";
import type { CanvasNode } from "@/types";
import type { CatalogModel } from "@/contract";
import { GenerationCost, useGenerationCosts } from "./GenerationCost";

function localExecution(node: CanvasNode): boolean {
	return ["episode.split", "image.depth", "video.depth"].includes(node.type);
}

/** Match the public parameters normalized by the normal canvas submission path. */
export function canvasGenerationRequest(node: CanvasNode, models: readonly CatalogModel[]): GenerationCostRequest {
	const plugin = getPlugin(node.type);
	const modelKey = resolveActiveModelKey(node.type, node.data.params.model, plugin?.defaultModel);
	const model = models.find(item => item.id === modelKey);
	let params = { ...node.data.params };
	if (plugin?.capability === "image") params = buildImageParams(params, imageResolutionOptions(model), model?.params);
	if (plugin?.capability === "video" && model) {
		const req = videoReqOptions(model), methods = modelMethods(model);
		if (params.duration !== undefined) params.duration = clampDurationTo(Math.round(Number(params.duration)) || 15, req.durations);
		if (typeof params.resolution === "string") params.resolution = clampToOptions(params.resolution, req.resolutions);
		if (typeof params.aspect_ratio === "string") params.aspect_ratio = clampToOptions(params.aspect_ratio, req.aspects);
		if (methods.length > 1) params.method = clampMethod(params.method, methods);
		else delete params.method;
	}
	const refVideoUris = (model?.refVideoSecondsWeight ?? 0) > 0
		? getNodeMaterialItems(node.id).filter(item => item.media === "video").map(item => item.uri)
		: [];
	return { modelKey, params, refVideoUris };
}

export function NodeGenerationCost({ nodeId }: { nodeId: string }) {
	const node = useCanvasStore(s => s.nodes[nodeId]);
	useCanvasStore(s => s.edges);
	useLibraryStore(s => s.assets);
	const models = useCatalogStore(s => s.catalog?.models);
	const modelKey = node ? resolveActiveModelKey(node.type, node.data.params.model, getPlugin(node.type)?.defaultModel) : "";
	const billsReferenceVideo = (models?.find(model => model.id === modelKey)?.refVideoSecondsWeight ?? 0) > 0;
	// Selecting an upstream history result changes its node, not the edge or asset library.
	// Subscribe to the material identities so that selection reprices without reacting to canvas movement.
	useCanvasStore(() => billsReferenceVideo && node
		? JSON.stringify(getNodeMaterialItems(nodeId).filter(item => item.media === "video").map(item => item.uri))
		: "");
	if (!node) return <GenerationCost cost={null} />;
	if (localExecution(node)) return <GenerationCost cost={0} />;
	return <GenerationCost {...canvasGenerationRequest(node, models ?? [])} />;
}

/** Batch estimate excludes entries the same run command will skip. */
export function NodeSelectionGenerationCost({ nodeIds }: { nodeIds: readonly string[] }) {
	const nodes = useCanvasStore(s => s.nodes), runtime = useCanvasStore(s => s.runtime);
	useCanvasStore(s => s.edges);
	useLibraryStore(s => s.assets);
	const models = useCatalogStore(s => s.catalog?.models);
	const requests = [...new Set(nodeIds)].flatMap(id => {
		const node = nodes[id];
		if (!node || !isRunnableNode(node, getPlugin(node.type)) || isNodeRunBusy(runtime[id]?.status, node) || localExecution(node)) return [];
		return [canvasGenerationRequest(node, models ?? [])];
	});
	const total = useGenerationCosts(requests);
	return <GenerationCost cost={total} />;
}
