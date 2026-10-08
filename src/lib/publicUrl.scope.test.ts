import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectStore } from "@/store/projectStore";
import { ensurePublicUrl } from "./publicUrl";

const { upload, heal } = vi.hoisted(() => ({ upload: vi.fn(), heal: vi.fn() }));
vi.mock("@/services/managedClient", () => ({ managedClient: { uploadAsset: upload } }));
vi.mock("@/services/assetHeal", () => ({ healPublicUrlIfDead: heal }));
const result = { id: "TP-one", url: "https://oss.example/one.png" };
const switchProject = () => useProjectStore.setState({ projectInstanceId: "project-b" });

describe("ensurePublicUrl 素材准备归属", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		useProjectStore.setState({ projectInstanceId: "project-a", isProjectLoading: false, assetBlobs: {} });
	});
	afterEach(() => vi.unstubAllGlobals());

	it("读取字节期间切项目，不上传、不登记", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, blob: async () => { switchProject(); return new Blob(["a"]); } })));
		expect(await ensurePublicUrl("blob:one")).toBe("");
		expect(upload).not.toHaveBeenCalled();
		expect(useProjectStore.getState().assetBlobs).toEqual({});
	});

	it("上传期间切项目，返回空且不把结果映射到新项目", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response(new Blob(["a"]))));
		upload.mockImplementationOnce(async () => { switchProject(); return result; });
		const busy = vi.fn();
		expect(await ensurePublicUrl("blob:one", { onUploading: busy })).toBe("");
		expect(useProjectStore.getState().assetBlobs).toEqual({});
		expect(busy.mock.calls).toEqual([[true], [false]]);
	});

	it("原目标删除时把同一取消守卫传到公网自愈", async () => {
		let exists = true;
		heal.mockImplementationOnce(async (_uri, _deps, current) => {
			expect(current()).toBe(true);
			exists = false;
			expect(current()).toBe(false);
			return result.url;
		});
		expect(await ensurePublicUrl(result.url, { shouldContinue: () => exists })).toBe("");
	});

	it("正常准备保留本地映射并复用缓存，仅上传一次", async () => {
		useProjectStore.getState().registerAssetBlob({ id: "LC-one", localUri: "blob:one" });
		vi.stubGlobal("fetch", vi.fn(async () => new Response(new Blob(["a"], { type: "image/png" }))));
		upload.mockResolvedValue(result);
		expect(await ensurePublicUrl("blob:one")).toBe(result.url);
		expect(await ensurePublicUrl("blob:one")).toBe(result.url);
		expect(upload).toHaveBeenCalledTimes(1);
		expect(useProjectStore.getState().assetBlobs["LC-one"]).toMatchObject({ localUri: "blob:one", url: result.url });
	});
});
