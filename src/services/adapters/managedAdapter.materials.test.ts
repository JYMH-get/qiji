import { officialMaterialController } from '../officialMaterialClient';
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogModel } from "@/contract";

const mocks = vi.hoisted(() => ({ prepare: vi.fn(), generate: vi.fn(), publicUrl: vi.fn(), blobByUri: vi.fn() }));
vi.mock("@/services/managedClient", () => ({ managedClient: { prepareMaterial: mocks.prepare, generate: mocks.generate } }));
vi.mock("@/store/projectStore", () => ({ useProjectStore: { getState: () => ({ savePath: "qa-project", name: "qa", blobByUri: mocks.blobByUri }) } }));
vi.mock("@/lib/publicUrl", () => ({ ensurePublicUrl: mocks.publicUrl, isPublicUrl: (url: string) => /^https?:\/\/assets\.test\//i.test(url) }));
import { buildManagedAdapter } from "./managedAdapter";
import { processModalParams } from "@/lib/processModalParams";

const model: CatalogModel = { id: "route:official", label: "优惠", capability: "video", params: [], cost: 1, materialPolicy: { kind: "official-assets", library: "sd", scopeKey: "sd-account" } };

describe("managed adapter material contract", () => {
	beforeEach(() => {
 officialMaterialController.clear();
		vi.clearAllMocks();
		mocks.prepare.mockImplementation(async body => ({ status: "Active", assetId: `asset-${body.asset.id || new URL(body.asset.url).pathname.split('/').pop()}`, checkedAt: Date.now(), scopeKey: "sd-account" }));
		mocks.generate.mockResolvedValue({ taskId: "qa-task" });
		mocks.publicUrl.mockImplementation(async url => url);
		mocks.blobByUri.mockReturnValue(undefined);
	});
	it('prepares video and audio with their own types and submits their certified IDs', async () => {
		const inputs = { images: [{ id: 'image' }], videos: [{ id: 'video', url: 'https://assets.test/v.mp4' }], audios: [{ id: 'audio', url: 'https://assets.test/a.mp3' }] };
		const snapshot = JSON.stringify(inputs);
		await buildManagedAdapter(model).submit({ inputs }, {}, 'video');
		expect(mocks.prepare).toHaveBeenCalledWith(expect.objectContaining({ asset: expect.objectContaining({ id: 'video', officialAssetType: 'Video' }) }));
		expect(mocks.prepare).toHaveBeenCalledWith(expect.objectContaining({ asset: expect.objectContaining({ id: 'audio', officialAssetType: 'Audio' }) }));
		const request = mocks.generate.mock.calls[0][0];
		expect(request.inputs.videos[0]).toMatchObject({ id: 'video', officialAssetId: 'asset-video' });
		expect(request.inputs.audios[0]).toMatchObject({ id: 'audio', officialAssetId: 'asset-audio' });
		expect(JSON.stringify(inputs)).toBe(snapshot);
	});
	it.each(['videos', 'audios'] as const)('blocks generation when %s preparation is pending or lacks an ID', async group => {
		for (const result of [{ status: 'Processing' }, { status: 'Active' }]) {
			officialMaterialController.clear();
			mocks.prepare.mockResolvedValue({ ...result, checkedAt: Date.now(), scopeKey: 'sd-account' });
			await expect(buildManagedAdapter(model).submit({ inputs: { [group]: [{ id: group }] } }, {}, 'video')).rejects.toThrow(/素材/);
		}
		expect(mocks.generate).not.toHaveBeenCalled();
	});
	it('missing official binding uploads with three retries, then turns red', async () => {
		vi.useFakeTimers();
		try {
			mocks.prepare.mockImplementation(async body => {
				if (body.action === 'inspect') return { status: 'Processing', checkedAt: Date.now(), scopeKey: 'sd-account', uploadRequired: true };
				throw new Error('upload unavailable');
			});
			const states = vi.fn();
			officialMaterialController.subscribe('retry-fixture', model.id, { id: 'file-retry' }, 'sd-account', states);
			await vi.advanceTimersByTimeAsync(5000);
			expect(mocks.prepare.mock.calls.filter(([body]) => body.action === 'upload')).toHaveLength(4);
			expect(states.mock.calls.some(([state]) => state.phase === 'checking')).toBe(true);
			expect(states.mock.calls.some(([state]) => state.phase === 'uploading')).toBe(true);
			expect(states).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'Failed' }));
		} finally { officialMaterialController.clear(); vi.useRealTimers(); }
	});
	it.each([undefined, [], [0, 1]])("prepares every official image regardless of legacy indexes %j and reuses certified state", async officialAssetIndexes => {
		const adapter = buildManagedAdapter(model);
		const input = { images: [{ id: "file-a" }, { id: "file-b", usage: "reference" }] };
		await adapter.submit(input, { duration: 5, officialAssetIndexes }, "video");
		await adapter.submit(input, { duration: 5, officialAssetIndexes }, "video");
		expect(mocks.prepare).toHaveBeenCalledTimes(2);
		expect(mocks.prepare).toHaveBeenCalledWith(expect.objectContaining({ model: model.id, asset: { id: "file-a", usage: "identity" } }));
		expect(mocks.prepare).toHaveBeenCalledWith(expect.objectContaining({ model: model.id, asset: { id: "file-b", usage: "identity" } }));
		expect(mocks.generate).toHaveBeenLastCalledWith(expect.objectContaining({ materialPolicyKey: "sd-account", params: { duration: 5, officialAssetIndexes }, inputs: { images: [{ id: "file-a", usage: "identity", officialAssetId: 'asset-file-a' }, { id: "file-b", usage: "identity", officialAssetId: 'asset-file-b' }] } }));
		expect(input.images).toEqual([{ id: "file-a" }, { id: "file-b", usage: "reference" }]);
	});
	it('checks the additional storyboard image and preserves image order, audio, video and original params', async () => {
		const inputs = { images: [{ id: 'tail', usage: 'reference' }, { id: 'reference' }],
			videos: [{ id: 'video', url: 'https://assets.test/video.mp4' }], audios: [{ id: 'audio', url: 'https://assets.test/audio.mp3' }] };
		const params = { firstFrameUrl: 'https://assets.test/storyboard.png', officialAssetIndexes: [], referenceMode: 'first_last_frame' };
		const before = JSON.stringify({ inputs, params });
		await buildManagedAdapter(model).submit({ inputs }, params, 'video');
		expect(mocks.prepare).toHaveBeenCalledTimes(5);
		expect(mocks.prepare.mock.calls.filter(([body]) => !body.asset.officialAssetType).map(([body]) => body.asset.id || body.asset.url)).toEqual(['tail', 'reference', params.firstFrameUrl]);
		const req = mocks.generate.mock.calls[0][0];
		expect(req.inputs.images).toEqual([{ id: 'tail', usage: 'identity', officialAssetId: 'asset-tail' }, { id: 'reference', usage: 'identity', officialAssetId: 'asset-reference' }]);
		expect(req.inputs.videos).toEqual(inputs.videos.map(asset => ({ ...asset, officialAssetId: 'asset-video' })));
		expect(req.inputs.audios).toEqual(inputs.audios.map(asset => ({ ...asset, officialAssetId: 'asset-audio' })));
		expect(req.params).toEqual({ ...params, firstFrameAssetId: 'asset-storyboard.png' });
		expect(JSON.stringify({ inputs, params })).toBe(before);
		expect(JSON.stringify(req)).not.toContain('asset://');
	});
	it('reuses duplicate image IDs and the unambiguous first-frame URL', async () => {
		const url = 'https://assets.test/shared.png';
		const images = [{ id: 'same', url }, { id: 'same' }, { url }];
		await buildManagedAdapter(model).submit({ images }, { firstFrameUrl: url }, 'video');
		expect(mocks.prepare).toHaveBeenCalledTimes(1);
		expect(mocks.generate.mock.calls[0][0].inputs.images.map((asset: { id?: string }) => asset.id)).toEqual(['same', 'same', undefined]);
		expect(mocks.generate.mock.calls[0][0].inputs.images.map((asset: { officialAssetId: string }) => asset.officialAssetId)).toEqual(['asset-same', 'asset-same', 'asset-same']);
		expect(mocks.generate.mock.calls[0][0].params.firstFrameAssetId).toBe('asset-same');
	});
	it('keeps media type in preparation and cache identity even with the same URL', async () => {
		mocks.prepare.mockImplementation(async body => ({ status: 'Active', assetId: `asset-${body.asset.officialAssetType || 'Image'}`, checkedAt: Date.now(), scopeKey: 'sd-account' }));
		const same = { url: 'https://assets.test/shared' };
		const input = { inputs: { images: [same], videos: [same], audios: [same, same] } };
		const adapter = buildManagedAdapter(model);
		await adapter.submit(input, {}, 'video');
		await adapter.submit(input, {}, 'video');
		expect(mocks.prepare).toHaveBeenCalledTimes(3);
		const request = mocks.generate.mock.calls[1][0];
		expect(request.inputs.images[0].officialAssetId).toBe('asset-Image');
		expect(request.inputs.videos[0].officialAssetId).toBe('asset-Video');
		expect(request.inputs.audios.map((asset: { officialAssetId: string }) => asset.officialAssetId)).toEqual(['asset-Audio', 'asset-Audio']);
		expect(same).toEqual({ url: 'https://assets.test/shared' });
	});
	it('keeps different IDs separate despite the same URL and prepares an ambiguous first frame by URL', async () => {
		const url = 'https://assets.test/shared.png';
		mocks.blobByUri.mockReturnValue({ id: 'same', url });
		const images = [{ id: 'same', url }, { id: 'same' }, { id: 'alias', url }];
		await buildManagedAdapter(model).submit({ images }, { firstFrameUrl: url }, 'video');
		expect(mocks.prepare).toHaveBeenCalledTimes(3);
		expect(mocks.prepare.mock.calls.map(([body]) => body.asset.id)).toEqual(['same', 'alias', undefined]);
		expect(mocks.generate.mock.calls[0][0].inputs.images.map((asset: { officialAssetId: string }) => asset.officialAssetId)).toEqual(['asset-same', 'asset-same', 'asset-alias']);
		expect(mocks.generate.mock.calls[0][0].params.firstFrameAssetId).toBe('asset-shared.png');
	});
	it('reuses the authoritative ID even when its URL-only reference occurs first', async () => {
		const url = 'https://assets.test/shared.png';
		await buildManagedAdapter(model).submit({ images: [{ url }, { id: 'identity', url }] }, {}, 'video');
		expect(mocks.prepare).toHaveBeenCalledTimes(1);
		expect(mocks.prepare).toHaveBeenCalledWith(expect.objectContaining({ asset: { id: 'identity', url, usage: 'identity' } }));
		expect(mocks.generate.mock.calls[0][0].inputs.images.map((asset: { officialAssetId: string }) => asset.officialAssetId)).toEqual(['asset-identity', 'asset-identity']);
	});
	it('prepares every image with the older officialAssets catalog flag', async () => {
		await buildManagedAdapter({ ...model, materialPolicy: undefined, officialAssets: true }).submit({ images: [{ id: 'old', usage: 'reference' }] }, { officialAssetIndexes: [] }, 'video');
		expect(mocks.prepare).toHaveBeenCalledWith(expect.objectContaining({ asset: { id: 'old', usage: 'identity' } }));
		expect(mocks.generate.mock.calls[0][0].inputs.images).toEqual([{ id: 'old', usage: 'identity', officialAssetId: 'asset-old' }]);
	});
	it.each(['Processing', 'Failed'])('blocks submission when an additional storyboard is %s', async status => {
		mocks.prepare.mockImplementation(async body => ({ status: body.asset.url ? status : 'Active', assetId: body.asset.url ? undefined : 'asset-image', error: 'review pending', checkedAt: Date.now(), scopeKey: 'sd-account' }));
		await expect(buildManagedAdapter(model).submit({ images: [{ id: 'image' }] }, { firstFrameUrl: 'https://assets.test/storyboard.png' }, 'video')).rejects.toThrow(/首帧\/故事板图片素材/);
		expect(mocks.generate).not.toHaveBeenCalled();
	});
	it('allows the next submission to retry a failed additional storyboard without a material card', async () => {
		mocks.prepare.mockResolvedValueOnce({ status: 'Failed', error: 'temporary failure', checkedAt: Date.now(), scopeKey: 'sd-account' });
		const adapter = buildManagedAdapter(model);
		const params = { firstFrameUrl: 'https://assets.test/storyboard.png' };
		await expect(adapter.submit({}, params, 'video')).rejects.toThrow(/temporary failure/);
		await adapter.submit({}, params, 'video');
		expect(mocks.prepare).toHaveBeenCalledTimes(2);
		expect(mocks.generate).toHaveBeenCalledOnce();
	});
	it.each([undefined, '', '  '])('blocks an Active preparation missing a usable asset ID %j', async assetId => {
		mocks.prepare.mockResolvedValue({ status: 'Active', assetId, checkedAt: Date.now(), scopeKey: 'sd-account' });
		await expect(buildManagedAdapter(model).submit({ images: [{ id: 'image' }] }, {}, 'video')).rejects.toThrow(/未返回素材库 ID/);
		expect(mocks.generate).not.toHaveBeenCalled();
	});
	it('carries the returned official ID when local preparation resolves an image to an uploaded project blob', async () => {
		const url = 'blob:local-only';
		const uploadedUrl = 'https://assets.test/uploaded.png';
		mocks.publicUrl.mockResolvedValue(uploadedUrl);
		mocks.blobByUri.mockReturnValue({ id: 'resolved-blob', url: uploadedUrl });
		const input = { images: [{ url }] };
		await buildManagedAdapter(model).submit(input, {}, 'video');
		expect(mocks.prepare).toHaveBeenCalledWith(expect.objectContaining({ asset: { id: 'resolved-blob', url: uploadedUrl, usage: 'identity' } }));
		expect(mocks.generate.mock.calls[0][0].inputs.images).toEqual([{ url, usage: 'identity', officialAssetId: 'asset-resolved-blob' }]);
		expect(input).toEqual({ images: [{ url }] });
	});
	it.each(["Processing", "Failed"])("does not submit generation while the checked asset is %s", async status => {
		mocks.prepare.mockResolvedValue({ status, error: "expired", checkedAt: Date.now(), scopeKey: "sd-account" });
		await expect(buildManagedAdapter(model).submit({ images: [{ id: "file-a", usage: "reference" }] }, {}, "video")).rejects.toThrow(/图片素材/);
		expect(mocks.generate).not.toHaveBeenCalled();
	});
	it("URL line ignores portrait metadata and still snapshots its own policy", async () => {
		await buildManagedAdapter({ ...model, materialPolicy: { kind: "url" }, officialAssets: true }).submit({ images: [{ id: "file-a", usage: "identity" }, { id: 'file-b', usage: 'reference' }] }, { firstFrameUrl: 'https://assets.test/storyboard.png' }, "video");
		expect(mocks.prepare).not.toHaveBeenCalled();
		expect(mocks.generate).toHaveBeenCalledWith(expect.objectContaining({ materialPolicyKey: "url" }));
		expect(mocks.generate.mock.calls[0][0].inputs.images).toEqual([{ id: "file-a", usage: "identity" }, { id: 'file-b', usage: 'reference' }]);
	});
	it.each(["video-enhance", "video-erase", "image-enhance", "text", "audio"] as const)("preserves all %s parameters regardless of the route catalog schema", async capability => {
		const processing: CatalogModel = { ...model, id: "route:processing", capability, materialPolicy: { kind: "url" }, params: [{ key: "strength", label: "强度", type: "number", default: 0.5 }, { key: "target", label: "输出规格", type: "text", default: "1080p" }] };
		await buildManagedAdapter(processing).submit({}, { strength: 0.8, target: "4k", prompt: "UI only", model: "old", idPrefix: "EN" }, "video");
		expect(mocks.generate).toHaveBeenCalledWith(expect.objectContaining({ params: { strength: 0.8, target: "4k", prompt: "UI only", model: "old", idPrefix: "EN" } }));
	});
	it('sends identical image parameters, prompt and reference inputs for direct and routed models', async () => {
		const params = Object.freeze({ resolution: '2K', aspect_ratio: '16:9', size: '2048x1152', imageSize: '2K',
			reference_strength: 0.9, seed: 0, negative_prompt: '', custom: { weights: [0.8, 0.2] }, selected: true });
		const inputs = { images: [{ id: 'reference-a', url: 'https://assets.test/a.png', usage: 'identity' as const },
			{ id: 'reference-b', url: 'https://assets.test/b.png', usage: 'reference' as const }] };
		const input = Object.freeze({ inputs, prompt: 'Keep the reference costumes.\nExact prompt.', promptOverride: 'Exact override', clientTaskId: 'same-request' });
		const before = JSON.stringify({ params, input });
		for (const id of ['banana-pro', 'route:banana-pro']) {
			await buildManagedAdapter({ ...model, id, capability: 'image', materialPolicy: { kind: 'url' }, params: [] }).submit(input, params, 'image.gen');
		}
		const [direct, routed] = mocks.generate.mock.calls.map(([request]) => request);
		expect(direct.params).toStrictEqual(params);
		expect(direct.params).not.toBe(params);
		expect(routed).toEqual({ ...direct, model: 'route:banana-pro' });
		expect(routed.inputs).toStrictEqual(inputs);
		expect(routed.variables).toEqual({ prompt: input.prompt });
		expect(routed.promptOverride).toBe(input.promptOverride);
		expect(JSON.stringify({ params, input })).toBe(before);
		expect(mocks.prepare).not.toHaveBeenCalled();
	});
	it("keeps the image-upscale modal's calculated multiple outside the tool_version catalog schema", async () => {
		const processing: CatalogModel = { ...model, id: "route:volc-image-enhance", capability: "image-enhance", materialPolicy: { kind: "url" }, params: [{ key: "tool_version", label: "增强版本", type: "enum", options: ["standard", "professional", "max"], default: "professional" }] };
		const params = processModalParams({ tool_version: "professional" }, { multiple: 2.5 });
		await buildManagedAdapter(processing).submit({ purpose: "image.upscale", images: [{ id: "source-file" }] }, params, "video");
		expect(mocks.generate).toHaveBeenCalledWith(expect.objectContaining({ purpose: "image.upscale", params: { tool_version: "professional", multiple: 2.5 } }));
	});
	it("keeps exact local erase boxes emitted by the modal though the catalog only declares mode", async () => {
		const processing: CatalogModel = { ...model, id: "route:volc-erase-subtitle", capability: "video-erase", materialPolicy: { kind: "url" }, params: [{ key: "mode", label: "擦除模式", type: "enum", options: ["Subtitle", "Text"], default: "Subtitle" }] };
		const params = processModalParams({ mode: "Subtitle" }, { eraseBoxes: [{ x1: 0.1, y1: 0.80123, x2: 0.9, y2: 0.98 }] });
		await buildManagedAdapter(processing).submit({ purpose: "video.desub", videos: [{ id: "source-file" }] }, params, "video");
		expect(mocks.generate).toHaveBeenCalledWith(expect.objectContaining({ purpose: "video.desub", params: { mode: "Subtitle", erase_ratio_location: [{ top_left_x: 0.1, top_left_y: 0.801, bottom_right_x: 0.9, bottom_right_y: 0.98 }] } }));
	});
});
