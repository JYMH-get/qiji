import { describe, expect, it } from "vitest";
import { estimateGenerationCost, generationCostLabel, sumGenerationCosts, type GenerationCostContext } from "./generationCost";

const pricing: GenerationCostContext = {
	models: [
		{ id: "image", cost: 12, costRules: [{ when: { resolution: "4k", quality: "high" }, cost: 25 }] },
		{ id: "video", cost: 30, costField: "duration", costPerUnit: 2, costRules: [{ when: { resolution: "1080p", method: "frames" }, costPerUnit: 2.5 }], refVideoSecondsWeight: 0.5 },
		{ id: "free", cost: 0 },
		{ id: "text", pricingHidden: true, cost: 99 },
	],
	localModelKeys: ["local-cli"], thirdPartyFee: 3,
	videoSeconds: { "reference-a": 1.2, "reference-b": 2.1 },
};

describe("generation button standard-price estimates", () => {
	it("uses exact image tier parameters and keeps extension fields intact", () => {
		const params = { resolution: "4k", quality: "high", extension: { arbitrary: true } };
		const before = structuredClone(params);
		expect(estimateGenerationCost({ modelKey: "image", params }, pricing)).toBe(25);
		expect(params).toEqual(before);
	});
	it("matches routed image aliases and rejects conflicting price specifications without changing input", () => {
		const context = { models: [{ id: "route:image", capability: "image", cost: 10, costRules: [{ when: { resolution: "4k", aspect_ratio: "9:16" }, cost: 35 }] }] };
		const params = { generationConfig: { imageConfig: { imageSize: "4K", aspectRatio: "9：16" } } };
		expect(estimateGenerationCost({ modelKey: "route:image", params }, context)).toBe(35);
		expect(params.generationConfig.imageConfig.imageSize).toBe("4K");
		expect(estimateGenerationCost({ modelKey: "route:image", params: { ...params, resolution: "2k" } }, context)).toBeNull();
	});
	it("uses route defaults only in the read-only pricing view", () => {
		const params = { duration: 10 };
		const context = { models: [{ id: "route:video", capability: "video", cost: 10, params: [{ key: "resolution", default: "1080p" }], methods: ["frames"], costRules: [{ when: { resolution: "1080p", method: "frames" }, cost: 35 }] }] };
		expect(estimateGenerationCost({ modelKey: "route:video", params }, context)).toBe(35);
		expect(params).toEqual({ duration: 10 });
	});
	it("prices each reference video with its own rounded seconds", () => {
		expect(estimateGenerationCost({ modelKey: "video", params: { duration: 10, resolution: "1080p", method: "frames" }, refVideoUris: ["reference-a", "reference-b"] }, pricing)).toBe(31);
	});
	it("does not present an incomplete reference-video total as a known cost", () => {
		expect(estimateGenerationCost({ modelKey: "video", params: { duration: 10 }, refVideoUris: ["reference-a", "loading"] }, pricing)).toBeNull();
		expect(estimateGenerationCost({ modelKey: "video", params: { duration: 10 }, refVideoSeconds: 5 }, pricing)).toBe(25);
	});
	it("adds per-request rounded costs and supports different models in one batch", () => {
		expect(sumGenerationCosts([
			{ modelKey: "video", params: { duration: 5, resolution: "1080p", method: "frames" }, count: 2 },
			{ modelKey: "image", params: { resolution: "4k", quality: "high" } },
			{ modelKey: "local-cli", count: 2 },
		], pricing)).toBe(57);
	});
	it("reads the current local fee without using a managed model price", () => {
		expect(estimateGenerationCost({ modelKey: "local-cli", count: 3 }, pricing)).toBe(9);
		expect(estimateGenerationCost({ modelKey: "local-cli" }, { ...pricing, thirdPartyFee: 0 })).toBe(0);
		expect(estimateGenerationCost({ modelKey: "local-cli" }, { ...pricing, thirdPartyFee: undefined })).toBeNull();
	});
	it("preserves zero-cost and empty batches while unknown prices remain unknown", () => {
		expect(estimateGenerationCost({ modelKey: "free" }, pricing)).toBe(0);
		expect(sumGenerationCosts([], pricing)).toBe(0);
		expect(estimateGenerationCost({ modelKey: "missing", count: 0 }, pricing)).toBe(0);
		expect(estimateGenerationCost({ modelKey: "missing" }, pricing)).toBeNull();
		expect(sumGenerationCosts([{ modelKey: "image" }, { modelKey: "missing" }], pricing)).toBeNull();
	});
	it("does not turn an omitted or invalid unit price into a free generation", () => {
		const request = { modelKey: "unit-video", params: { duration: 10, resolution: "1080p" } };
		const model = { id: "unit-video", costField: "duration", cost: 50 };
		expect(estimateGenerationCost(request, { models: [model] })).toBeNull();
		expect(estimateGenerationCost(request, { models: [{ ...model, costPerUnit: NaN }] })).toBeNull();
		expect(estimateGenerationCost(request, { models: [{ ...model, costPerUnit: 0 }] })).toBe(0);
		expect(estimateGenerationCost(request, { models: [{ ...model, costRules: [{ when: { resolution: "1080p" }, costPerUnit: 0 }] }] })).toBe(0);
	});
	it("does not guess hidden text prices or apply an unverified membership discount", () => {
		expect(estimateGenerationCost({ modelKey: "text" }, pricing)).toBeNull();
		expect(generationCostLabel(null, true)).toBe("按用量计费");
		expect(generationCostLabel(25)).toBe("约 25 积分");
		expect(generationCostLabel(null)).toBe("积分待确认");
	});
});
