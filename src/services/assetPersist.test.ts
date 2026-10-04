import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), copy: vi.fn(), thumb: vi.fn() }));
vi.mock("@/store/projectStore", () => ({ useProjectStore: { getState: () => ({ savePath: "D:/project/test.Qiji" }) } }));
vi.mock("@/lib/publicUrl", () => ({ isWebviewLocalUri: (u: string) => u.includes("asset.localhost") }));
vi.mock("@tauri-apps/api/path", () => ({ dirname: async () => "D:/project", join: async (...p: string[]) => p.join("/") }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, convertFileSrc: (p: string) => "asset://" + p }));
vi.mock("@tauri-apps/plugin-fs", () => ({ exists: async () => true, mkdir: async () => {}, copyFile: mocks.copy, remove: async () => {} }));
vi.mock("./thumbGen", () => ({ ensureThumb: mocks.thumb }));
import { saveRemoteAsset } from "./assetPersist";
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
describe("原链产物按本地素材接收", () => {
	it("下载本地原件，来源链不充当 OSS 缓存，也不自动上传缩略图", async () => {
		vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
		mocks.invoke.mockImplementation(async (cmd: string) => cmd === "download_url" ? { path: "D:/temp/media", content_type: "image/png" } : undefined);
		const r = await saveRemoteAsset("LC-task", "https://upstream.test/result.png", { keepRemoteUrl: false });
		expect(r).toMatchObject({ id: "LC-task", srcUri: "https://upstream.test/result.png", localPath: "D:/project/assets/LC-task.png" });
		expect(r?.url).toBeUndefined();
		expect(mocks.copy).toHaveBeenCalledOnce();
		expect(mocks.thumb).not.toHaveBeenCalled();
	});
	it("正常 OSS 视频继续保留可复用链接", async () => {
		vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
		mocks.invoke.mockImplementation(async (cmd: string) => cmd === "download_url" ? { path: "D:/temp/media", content_type: "video/mp4" } : undefined);
		const r = await saveRemoteAsset("video00000001", "https://oss.test/result.mp4");
		expect(r?.url).toBe("https://oss.test/result.mp4");
		expect(r?.localUri).toBeTruthy();
	});
});
