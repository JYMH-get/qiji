import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ state: {} as any, start: vi.fn(), modelKey: "image-A", submissions: [] as { owner: string; spec: any }[] }));
vi.mock("@/store/projectStore", () => ({ useProjectStore: { getState: () => h.state } }));
vi.mock("@/components/ModelPicker", () => ({ effectiveModelKey: () => h.modelKey }));
vi.mock("@/store/catalogStore", () => ({
	useCatalogStore: { getState: () => ({ catalog: { templates: [] }, model: () => undefined }) },
}));
vi.mock("@/services/generationQueue", () => ({ startGeneration: h.start }));

import { generateAssetBaseImage } from "./assetGenActions";
import { startGeneration } from "@/services/generationQueue";

beforeEach(() => {
	vi.clearAllMocks();
	expect(startGeneration).toBe(h.start);
	h.submissions = [];
	h.modelKey = "image-A";
	h.state = {
		projectInstanceId: "project-A", isProjectLoading: false, mediaSettings: { imageAspect: "9:16" },
		characters: [{ id: "hero", name: "角色 A", prompt: "A 的提示词" }], pendingGens: [],
	};
	h.start.mockImplementation((spec) => {
		h.submissions.push({ owner: h.state.projectInstanceId, spec });
		h.state.pendingGens.push({ ...spec, status: "running" });
	});
	vi.stubGlobal("alert", vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

describe("RTC 资产基础形象同步受理", () => {
	it("点击即由 A 登记受理，随后切同 ID 复制项目不会把请求发给 B", async () => {
		const pending = generateAssetBaseImage("characters", "hero");
		h.state = { ...h.state, projectInstanceId: "project-B", characters: [{ id: "hero", name: "角色 B", prompt: "B 的提示词" }] };
		expect(await pending).toBe(true);
		expect(h.submissions).toHaveLength(1);
		expect(h.submissions[0]).toMatchObject({ owner: "project-A", spec: { prompt: "A 的提示词" } });
	});

	it("原资产已被删除时，不产生失去落点的请求", async () => {
		h.state = { ...h.state, characters: [] };
		expect(await generateAssetBaseImage("characters", "hero")).toBe(false);
		expect(h.start).not.toHaveBeenCalled();
	});

	it("连续点击同一资产，只受理一次", async () => {
		const first = generateAssetBaseImage("characters", "hero");
		const second = generateAssetBaseImage("characters", "hero");
		expect(await Promise.all([first, second])).toEqual([true, false]);
		expect(h.start).toHaveBeenCalledTimes(1);
	});

	it("别的入口已受理同资产，当前操作停止", async () => {
		h.state.pendingGens.push({ cat: "characters", assetId: "hero", variantId: null, status: "running" });
		expect(await generateAssetBaseImage("characters", "hero")).toBe(false);
		expect(h.start).not.toHaveBeenCalled();
	});

	it("同 ID 新项目独立受理，两次请求分别归各自项目", async () => {
		const old = generateAssetBaseImage("characters", "hero");
		h.state = { ...h.state, projectInstanceId: "project-B", pendingGens: [], characters: [{ id: "hero", name: "角色 B", prompt: "B 的提示词" }] };
		const current = generateAssetBaseImage("characters", "hero");
		expect(await Promise.all([old, current])).toEqual([true, true]);
		expect(h.start).toHaveBeenCalledTimes(2);
		expect(h.submissions).toMatchObject([
			{ owner: "project-A", spec: { prompt: "A 的提示词" } },
			{ owner: "project-B", spec: { prompt: "B 的提示词", label: "角色 B" } },
		]);
	});

	it("冻结点击时的提示词、模型和比例，不混入随后的新编辑", async () => {
		const pending = generateAssetBaseImage("characters", "hero");
		h.state.characters[0].prompt = "后改的提示词";
		h.state.mediaSettings.imageAspect = "1:1";
		h.modelKey = "image-B";
		expect(await pending).toBe(true);
		expect(h.start.mock.calls[0][0]).toMatchObject({ prompt: "A 的提示词", modelKey: "image-A", params: { aspect_ratio: "9:16" } });
	});

	it("项目正在载入时不提交，完成后仍可正常发起", async () => {
		h.state.isProjectLoading = true;
		expect(await generateAssetBaseImage("characters", "hero")).toBe(false);
		h.state.isProjectLoading = false;
		expect(await generateAssetBaseImage("characters", "hero")).toBe(true);
		expect(h.start).toHaveBeenCalledTimes(1);
	});

	it("队列受理抛错后可重试，不遗留额外准备锁", async () => {
		h.start.mockImplementationOnce(() => { throw new Error("queue unavailable"); });
		await expect(generateAssetBaseImage("characters", "hero")).rejects.toThrow("queue unavailable");
		expect(await generateAssetBaseImage("characters", "hero")).toBe(true);
		expect(h.start).toHaveBeenCalledTimes(2);
	});
});
