import { describe, expect, it, vi } from "vitest";
import type { Catalog, CatalogModel, GenerateRequest } from "@/contract";
import {
	accelerateNyxenRequest,
	nyxenRequestForWire,
	shouldUseNyxenAcceleration,
	type NyxenAcceleratedAssetRef,
} from "./nyxenAcceleration";

const model = (modeId: string, capability: CatalogModel["capability"] = "video"): CatalogModel => ({
	id: "seedance-stable",
	label: "Seedance 稳定",
	capability,
	modeId,
	params: [],
	cost: 1,
});

const catalog = {
	version: "test",
	models: [],
	templates: [],
	nodes: [],
	schemas: {},
	imageTemplates: [],
	variantPrefixes: [],
	modes: [
		{ id: "fast", name: "稳定" },
		{ id: "other", name: "其他" },
	],
} as Catalog;

describe("nyxen stable acceleration", () => {
	it("只按 catalog 中视频模型的稳定模式启用", () => {
		expect(shouldUseNyxenAcceleration(model("fast"), catalog)).toBe(true);
		expect(shouldUseNyxenAcceleration(model("other"), catalog)).toBe(false);
		expect(shouldUseNyxenAcceleration(model("fast", "image"), catalog)).toBe(false);
	});

	it("逐个上传、复用重复素材，并且只改请求副本", async () => {
		const original: GenerateRequest = {
			purpose: "video.generate",
			model: "seedance-stable",
			clientTaskId: "c1",
			projectId: "p1",
			params: { firstFrameUrl: "https://oss.test/storyboard.jpg" },
			inputs: {
				images: [
					{ id: "img1", url: "https://stale.test/img1.jpg", name: "角色" },
					{ url: "https://oss.test/storyboard.jpg", name: "重复故事板" },
				],
				videos: [{ url: "https://oss.test/ref.mp4", name: "动作" }],
			},
		};
		const uploaded: string[] = [];
		const stages: string[] = [];
		const result = await accelerateNyxenRequest(original, {
			resolveAssetUrl: async (id) => `https://fresh.test/${id}.jpg`,
			upload: async (url) => {
				uploaded.push(url);
				return `https://r2.test/${uploaded.length}`;
			},
			onProgress: (_p, _s, _t, extra) => stages.push(extra?.stageText ?? ""),
			afterSuccess: async () => undefined,
		});

		expect(uploaded).toEqual([
			"https://oss.test/storyboard.jpg",
			"https://fresh.test/img1.jpg",
			"https://oss.test/ref.mp4",
		]);
		expect(result.params?.firstFrameUrl).toBe("https://oss.test/storyboard.jpg");
		expect(result.params?.firstFrameAccelerationUrl).toBe("https://r2.test/1");
		expect(result.inputs?.images?.[1]).toMatchObject({
			url: "https://oss.test/storyboard.jpg",
			accelerationUrl: "https://r2.test/1",
		});
		expect(result.inputs?.images?.[0]).toEqual({
			id: "img1",
			name: "角色",
			url: "https://stale.test/img1.jpg",
			accelerationUrl: "https://r2.test/2",
		});
		expect((result.inputs?.videos?.[0] as NyxenAcceleratedAssetRef).accelerationUrl).toBe("https://r2.test/3");
		expect(original.params?.firstFrameUrl).toBe("https://oss.test/storyboard.jpg");
		expect(original.inputs?.images?.[0].url).toBe("https://stale.test/img1.jpg");
		expect(original.inputs?.images?.[0].id).toBe("img1");
		const wire = nyxenRequestForWire(result);
		expect(wire.params?.firstFrameUrl).toBe("https://r2.test/1");
		expect(wire.params?.firstFrameAccelerationUrl).toBeUndefined();
		expect(wire.inputs?.images?.[0]).toEqual({ name: "角色", url: "https://r2.test/2" });
		expect(wire.inputs?.images?.[1]).toEqual({ name: "重复故事板", url: "https://r2.test/1" });
		expect(stages).toContain("第1张图片上传中（共 3 个素材）");
		expect(stages).toContain("第1个视频上传成功");
	});

	it("某个素材失败时明确指出位置并停止后续上传", async () => {
		const upload = vi.fn(async (url: string) => {
			if (url.endsWith("2.jpg")) throw new Error("timeout");
			return "https://r2.test/ok";
		});
		const req: GenerateRequest = {
			purpose: "video.generate",
			model: "seedance-stable",
			clientTaskId: "c2",
			projectId: "p1",
			inputs: { images: [{ url: "https://oss.test/1.jpg" }, { url: "https://oss.test/2.jpg" }, { url: "https://oss.test/3.jpg" }] },
		};
		await expect(accelerateNyxenRequest(req, {
			resolveAssetUrl: async () => "",
			upload,
			afterSuccess: async () => undefined,
		})).rejects.toThrow("第2张图片上传加速桶失败：timeout");
		expect(upload).toHaveBeenCalledTimes(2);
	});
});
