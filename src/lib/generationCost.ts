import { estimateCost } from "./genParams";

export interface GenerationCostRequest {
	modelKey?: string;
	params?: Record<string, unknown>;
	/** Number of identical requests, not the model's own quantity parameter. */
	count?: number;
	refVideoUris?: readonly string[];
	refVideoSeconds?: number;
}

export type GenerationCostModel = NonNullable<Parameters<typeof estimateCost>[0]> & {
	id: string;
	capability?: string;
	params?: readonly { key: string; default?: unknown }[];
	methods?: readonly string[];
};
export interface GenerationCostContext {
	models: readonly GenerationCostModel[];
	localModelKeys?: readonly string[];
	thirdPartyFee?: number;
	videoSeconds?: Readonly<Record<string, number>>;
}

/** The server prices a normalized copy for routes/images; the submitted values stay intact. */
function pricingParams(model: GenerationCostModel, request: Record<string, unknown>): Record<string, unknown> | null {
	if (!model.id.startsWith("route:") && model.capability !== "image") return request;
	const fields = model.params ?? [];
	const params = { ...Object.fromEntries(fields.filter(field => field.default !== undefined).map(field => [field.key, field.default])), ...request };
	if (fields.some(field => field.key === "botType")) {
		if (request.aspectRatio === undefined) params.aspectRatio = request.aspect_ratio ?? request.aspect ?? params.aspectRatio;
		return params;
	}
	if (model.capability === "image") {
		const object = (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value);
		if (request.generationConfig !== undefined && !object(request.generationConfig)) return null;
		const config = (request.generationConfig ?? {}) as Record<string, unknown>;
		if (config.imageConfig !== undefined && !object(config.imageConfig)) return null;
		const imageConfig = (config.imageConfig ?? {}) as Record<string, unknown>;
		const resolution = [imageConfig.imageSize, request.imageSize, request.resolution].map(value => String(value ?? "").trim().toLowerCase()).filter(Boolean);
		const aspectOf = (value: unknown) => String(value ?? "").trim().replace("：", ":").toLowerCase();
		const sizeAspect = /^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/.test(aspectOf(request.size)) ? request.size : undefined;
		const aspect = [imageConfig.aspectRatio, request.aspectRatio, request.aspect_ratio, sizeAspect].map(aspectOf).filter(Boolean);
		if (new Set(resolution).size > 1 || new Set(aspect).size > 1) return null;
		params.resolution = resolution[0] || "2k";
		params.aspect_ratio = aspect[0] || "16:9";
	}
	if (model.capability === "video" && params.method === undefined) params.method = model.methods?.[0] ?? "omni";
	return params;
}

/** Catalog retail estimate. Membership is settled by the server for the selected wallet. */
export function estimateGenerationCost(request: GenerationCostRequest, context: GenerationCostContext): number | null {
	const count = request.count ?? 1;
	if (!Number.isInteger(count) || count < 0) return null;
	if (count === 0) return 0;
	if (!request.modelKey) return null;
	if (context.localModelKeys?.includes(request.modelKey)) {
		const fee = context.thirdPartyFee;
		return typeof fee === "number" && Number.isFinite(fee) && fee >= 0 ? fee * count : null;
	}
	const model = context.models.find(item => item.id === request.modelKey);
	if (!model) return null;
	const params = pricingParams(model, request.params ?? {});
	if (!params) return null;
	if (model.costField && Number(params[model.costField]) > 0 && !model.tokenPricing?.enabled) {
		const rule = model.costRules?.find(item => Object.keys(item.when ?? {}).every(key => String(params[key]) === String(item.when[key])));
		const perUnit = rule?.costPerUnit ?? model.costPerUnit;
		// The legacy estimator defaults an omitted unit price to zero. Absence is not a free offer.
		if (typeof perUnit !== "number" || !Number.isFinite(perUnit) || perUnit < 0) return null;
	}
	let refSeconds = request.refVideoSeconds ?? 0;
	if ((model?.refVideoSecondsWeight ?? 0) > 0 && request.refVideoSeconds === undefined) {
		for (const uri of request.refVideoUris ?? []) {
			const seconds = context.videoSeconds?.[uri];
			// Do not present a partial total as the cost while metadata is still unknown.
			if (!Number.isFinite(seconds) || !seconds || seconds <= 0) return null;
			refSeconds += Math.ceil(seconds);
		}
	}
	const cost = estimateCost(model, params, refSeconds);
	return cost === null || !Number.isFinite(cost) || cost < 0 ? null : cost * count;
}

/** Each request is rounded by estimateCost before its contribution is added. */
export function sumGenerationCosts(requests: readonly GenerationCostRequest[], context: GenerationCostContext): number | null {
	let total = 0;
	for (const request of requests) {
		const cost = estimateGenerationCost(request, context);
		if (cost === null) return null;
		total += cost;
	}
	return total;
}

export function generationCostLabel(cost: number | null, pricingHidden = false): string {
	if (pricingHidden) return "按用量计费";
	return cost === null ? "积分待确认" : `约 ${cost.toLocaleString("zh-CN", { maximumFractionDigits: 4 })} 积分`;
}
