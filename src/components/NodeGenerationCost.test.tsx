import { beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ state: {} as any, models: [] as any[], subscriptions: [] as { select: (state: any) => unknown; value: unknown }[] }));
vi.mock("@/store/canvasStore", () => ({ useCanvasStore: (select: (state: any) => unknown) => {
	const value = select(fixture.state);
	fixture.subscriptions.push({ select, value });
	return value;
} }));
vi.mock("@/store/catalogStore", () => ({ useCatalogStore: (select: (state: any) => unknown) => select({ catalog: { models: fixture.models } }) }));
vi.mock("@/store/libraryStore", () => ({ useLibraryStore: (select: (state: any) => unknown) => select({ assets: fixture.state.assets }) }));
vi.mock("@/canvas/nodeMaterials", () => ({ getNodeMaterialItems: () => [{ media: "video", uri: fixture.state.assets[fixture.state.nodes.upstream.data.resultAssetId].uri }] }));
vi.mock("@/nodes/pluginRegistry", () => ({ getPlugin: () => ({ capability: "video" }) }));
vi.mock("@/services/adapters/channelAdapter", () => ({ resolveActiveModelKey: (_type: string, model: string) => model }));
vi.mock("./GenerationCost", () => ({ GenerationCost: () => null, useGenerationCosts: () => null }));

import { NodeGenerationCost } from "./NodeGenerationCost";
import { estimateGenerationCost } from "@/lib/generationCost";

beforeEach(() => {
	fixture.subscriptions = [];
	fixture.models = [{ id: "video-model", capability: "video", params: [], costField: "duration", costPerUnit: 2, refVideoSecondsWeight: 1 }];
	fixture.state = {
		nodes: {
			target: { id: "target", type: "video", data: { params: { model: "video-model", duration: 10 } } },
			upstream: { id: "upstream", type: "video", x: 0, data: { resultAssetId: "short" } },
		},
		edges: { edge: { source: "upstream", target: "target" } },
		assets: { short: { uri: "short.mp4" }, long: { uri: "long.mp4" } },
	};
});

it("reprices after the upstream video history changes without a library/edge change, but ignores movement", () => {
	const price = (element: ReturnType<typeof NodeGenerationCost>) => estimateGenerationCost(element.props, {
		models: fixture.models, videoSeconds: { "short.mp4": 4, "long.mp4": 12 },
	});
	expect(price(NodeGenerationCost({ nodeId: "target" }))).toBe(28);
	fixture.state = { ...fixture.state, nodes: { ...fixture.state.nodes, upstream: { ...fixture.state.nodes.upstream, x: 50 } } };
	expect(fixture.subscriptions.some(subscription => subscription.select(fixture.state) !== subscription.value)).toBe(false);
	fixture.state = { ...fixture.state, nodes: { ...fixture.state.nodes, upstream: { ...fixture.state.nodes.upstream, data: { resultAssetId: "long" } } } };
	expect(fixture.subscriptions.some(subscription => subscription.select(fixture.state) !== subscription.value)).toBe(true);
	expect(price(NodeGenerationCost({ nodeId: "target" }))).toBe(44);
});
