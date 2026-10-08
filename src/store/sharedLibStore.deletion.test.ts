import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SharedAssetRecord, SharedFolderInfo, SharedLibraryInfo } from "@/contract";

const mocks = vi.hoisted(() => ({
	sharedLibraries: vi.fn(),
	sharedFolders: vi.fn(),
	sharedFolderAssets: vi.fn(),
	invoke: vi.fn(),
	removeFile: vi.fn().mockResolvedValue(undefined),
	writeTextFile: vi.fn().mockResolvedValue(undefined),
	readTextFile: vi.fn(),
}));
vi.mock("@/services/managedClient", () => ({ managedClient: mocks }));
vi.mock("@tauri-apps/api/path", () => ({
	appDataDir: async () => "/app",
	join: async (...parts: string[]) => parts.join("/"),
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
	exists: async (path: string) => !path.endsWith(".png"),
	mkdir: vi.fn(),
	copyFile: vi.fn().mockResolvedValue(undefined),
	remove: mocks.removeFile,
	writeTextFile: mocks.writeTextFile,
	readTextFile: mocks.readTextFile,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, convertFileSrc: (path: string) => `asset://${path}` }));

import { useSharedLibStore, type CachedSharedAsset } from "./sharedLibStore";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
	return { promise, resolve, reject };
}

const asset = (id: string, assetId = id): CachedSharedAsset => ({
	id, assetId, name: id, url: `https://assets.invalid/${assetId}.png`,
	localPath: `/app/shared/${assetId}.png`, localUri: `asset://${assetId}`,
});
let saved = "";

beforeEach(() => {
	vi.clearAllMocks();
	mocks.sharedLibraries.mockReset();
	mocks.sharedFolders.mockReset();
	mocks.sharedFolderAssets.mockReset();
	mocks.invoke.mockReset();
	mocks.writeTextFile.mockReset().mockResolvedValue(undefined);
	mocks.readTextFile.mockReset();
	vi.stubGlobal("window", {});
	vi.stubGlobal("localStorage", { setItem: (_key: string, value: string) => { saved = value; } });
	saved = "";
	useSharedLibStore.setState({
		initialized: true,
		libs: [{ id: "lib", name: "团队库", folderCount: 2, assetCount: 6 }, { id: "other", name: "其他库", folderCount: 1, assetCount: 1 }],
		foldersByLib: { lib: [{ id: "folder", name: "待删目录", count: 5 }, { id: "sibling", name: "保留目录", count: 1 }], other: [{ id: "other-folder", name: "其他目录", count: 1 }] },
		assetsByFolder: { folder: [asset("a", "same-asset"), asset("b")], sibling: [asset("another-record", "same-asset")], "other-folder": [asset("other-record")] },
		lastView: { libId: "lib", folderId: "folder" },
		fetching: {},
	});
});
afterEach(async () => {
	await useSharedLibStore.getState().save();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("共享库删除后的客户端缓存", () => {
	it("仅移除指定素材记录、扣减两级数量并持久化，其他共享引用及本地文件保留", async () => {
		const sibling = useSharedLibStore.getState().assetsByFolder.sibling;
		useSharedLibStore.getState().removeAsset("folder", "a");
		const state = useSharedLibStore.getState();
		expect(state.assetsByFolder.folder.map((record) => record.id)).toEqual(["b"]);
		expect(state.assetsByFolder.sibling).toBe(sibling);
		expect(state.assetsByFolder.sibling[0].localPath).toBe("/app/shared/same-asset.png");
		expect(state.foldersByLib.lib[0].count).toBe(4);
		expect(state.libs.map((lib) => [lib.folderCount, lib.assetCount])).toEqual([[2, 5], [1, 1]]);
		expect(state.lastView).toEqual({ libId: "lib", folderId: "folder" });
		await state.save();
		expect(JSON.parse(saved).assetsByFolder.folder.map((record: SharedAssetRecord) => record.id)).toEqual(["b"]);
		expect(mocks.removeFile).not.toHaveBeenCalled();
	});

	it("删除文件夹使用清单中的总数量，清素材缓存并退回所在库，重复删除不再扣减", async () => {
		useSharedLibStore.setState({ fetching: { lib: { done: 0, total: 1 }, folder: { done: 1, total: 5 }, sibling: { done: 1, total: 2 } } });
		useSharedLibStore.getState().removeFolder("lib", "folder");
		useSharedLibStore.getState().removeFolder("lib", "folder");
		const state = useSharedLibStore.getState();
		expect(state.foldersByLib.lib.map((folder) => folder.id)).toEqual(["sibling"]);
		expect(state.assetsByFolder.folder).toBeUndefined();
		expect(state.libs[0]).toMatchObject({ folderCount: 1, assetCount: 1 });
		expect(state.lastView).toEqual({ libId: "lib" });
		expect(state.fetching).toEqual({ sibling: { done: 1, total: 2 } });
		await state.save();
		expect(JSON.parse(saved).assetsByFolder.folder).toBeUndefined();
		expect(mocks.removeFile).not.toHaveBeenCalled();
	});

	it("重复删除素材或删除未知记录不改变数量，已失配的零数量不会变成负数", () => {
		useSharedLibStore.setState({ libs: [{ id: "lib", name: "团队库", folderCount: 0, assetCount: 0 }], foldersByLib: { lib: [{ id: "folder", name: "目录", count: 0 }] } });
		useSharedLibStore.getState().removeAsset("folder", "a");
		useSharedLibStore.getState().removeAsset("folder", "a");
		useSharedLibStore.getState().removeAsset("unloaded-folder", "missing");
		expect(useSharedLibStore.getState().libs[0].assetCount).toBe(0);
		expect(useSharedLibStore.getState().foldersByLib.lib[0].count).toBe(0);
		useSharedLibStore.getState().removeFolder("lib", "folder");
		expect(useSharedLibStore.getState().libs[0]).toMatchObject({ folderCount: 0, assetCount: 0 });
	});

	it("删除其他文件夹保留当前浏览位置", () => {
		useSharedLibStore.getState().removeFolder("lib", "sibling");
		expect(useSharedLibStore.getState().lastView).toEqual({ libId: "lib", folderId: "folder" });
	});

	it("删除文件夹后丢弃在途文件夹、素材与库数量旧回包", async () => {
		const folders = deferred<SharedFolderInfo[]>();
		const assets = deferred<SharedAssetRecord[]>();
		const libs = deferred<SharedLibraryInfo[]>();
		const previous = useSharedLibStore.getState();
		mocks.sharedLibraries.mockReturnValue(libs.promise);
		mocks.sharedFolders.mockReturnValue(folders.promise);
		mocks.sharedFolderAssets.mockReturnValue(assets.promise);
		const pending = [previous.fetchLibs(), previous.fetchFolders("lib"), previous.fetchFolderAssets("folder")];
		useSharedLibStore.getState().removeFolder("lib", "folder");
		libs.resolve(previous.libs);
		folders.resolve(previous.foldersByLib.lib);
		assets.resolve(previous.assetsByFolder.folder);
		await Promise.all(pending);
		expect(useSharedLibStore.getState().assetsByFolder.folder).toBeUndefined();
		expect(useSharedLibStore.getState().foldersByLib.lib.map((folder) => folder.id)).toEqual(["sibling"]);
		expect(useSharedLibStore.getState().libs[0]).toMatchObject({ folderCount: 1, assetCount: 1 });
		expect(useSharedLibStore.getState().fetching).toEqual({});
	});

	it("删除素材后旧素材及数量清单不能复活，其他文件夹的在途获取仍正常完成", async () => {
		const folders = deferred<SharedFolderInfo[]>();
		const assets = deferred<SharedAssetRecord[]>();
		const previous = useSharedLibStore.getState();
		mocks.sharedFolders.mockReturnValue(folders.promise);
		mocks.sharedFolderAssets.mockImplementation((id: string) => id === "folder" ? assets.promise : Promise.resolve([asset("fresh")]));
		const pending = [previous.fetchFolders("lib"), previous.fetchFolderAssets("folder"), previous.fetchFolderAssets("sibling")];
		useSharedLibStore.getState().removeAsset("folder", "a");
		folders.resolve(previous.foldersByLib.lib);
		assets.resolve(previous.assetsByFolder.folder);
		await Promise.all(pending);
		expect(useSharedLibStore.getState().assetsByFolder.folder.map((record) => record.id)).toEqual(["b"]);
		expect(useSharedLibStore.getState().foldersByLib.lib[0].count).toBe(4);
		expect(useSharedLibStore.getState().assetsByFolder.sibling[0].id).toBe("fresh");
	});

	it("新获取可以在删除后继续，旧请求结束不能清理新进度或覆盖新结果", async () => {
		const oldResponse = deferred<SharedAssetRecord[]>();
		const newResponse = deferred<SharedAssetRecord[]>();
		mocks.sharedFolderAssets.mockReturnValueOnce(oldResponse.promise).mockReturnValueOnce(newResponse.promise);
		const previous = useSharedLibStore.getState();
		const oldFetch = previous.fetchFolderAssets("folder");
		previous.removeAsset("folder", "a");
		const newFetch = previous.fetchFolderAssets("folder");
		oldResponse.resolve(previous.assetsByFolder.folder);
		await oldFetch;
		expect(useSharedLibStore.getState().fetching.folder).toEqual({ done: 0, total: 1 });
		expect(useSharedLibStore.getState().assetsByFolder.folder.map((record) => record.id)).toEqual(["b"]);
		newResponse.resolve([asset("b"), { id: "new", name: "新增", url: "https://assets.invalid/new.png" }]);
		await newFetch;
		expect(useSharedLibStore.getState().assetsByFolder.folder.map((record) => record.id)).toEqual(["b", "new"]);
		expect(useSharedLibStore.getState().assetsByFolder.folder[1].localUri).toBe("https://assets.invalid/new.png");
		expect(useSharedLibStore.getState().fetching.folder).toBeUndefined();
	});

	it.each(["folder", "asset"])("在途本地下载不会在删除 %s 后回填缓存或恢复进度", async (kind) => {
		vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
		const downloaded = deferred<{ path: string; content_type: string }>();
		mocks.invoke.mockReturnValue(downloaded.promise);
		mocks.sharedFolderAssets.mockResolvedValue([{ id: "a", name: "a", url: "https://assets.invalid/a.png" }]);
		useSharedLibStore.setState({ assetsByFolder: {} });
		const pending = useSharedLibStore.getState().fetchFolderAssets("folder");
		await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalled());
		if (kind === "folder") useSharedLibStore.getState().removeFolder("lib", "folder");
		else useSharedLibStore.getState().removeAsset("folder", "a");
		downloaded.resolve({ path: "/temp/download.png", content_type: "image/png" });
		await pending;
		expect(useSharedLibStore.getState().assetsByFolder.folder).toEqual(kind === "folder" ? undefined : []);
		expect(useSharedLibStore.getState().fetching.folder).toBeUndefined();
		expect(mocks.removeFile.mock.calls.every(([path]) => path === "/temp/download.png")).toBe(true);
	});

	it("旧缓存写入延迟时删除保存按序落盘，排队保存读取最新状态且重载不复活", async () => {
		vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
		const firstWrite = deferred<void>();
		let persisted = "";
		mocks.writeTextFile.mockImplementation(async (_path: string, data: string) => {
			if (mocks.writeTextFile.mock.calls.length === 1) await firstWrite.promise;
			persisted = data;
		});
		const state = useSharedLibStore.getState();
		const oldSave = state.save();
		await vi.waitFor(() => expect(mocks.writeTextFile).toHaveBeenCalledTimes(1));
		const queuedBeforeDelete = state.save();
		state.removeAsset("folder", "a");
		state.removeFolder("lib", "folder");
		const latestSave = state.save();
		try {
			// 等待异步文件路径准备，确认旧写入未结束时不会并行启动新写入。
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(mocks.writeTextFile).toHaveBeenCalledTimes(1);
		} finally {
			firstWrite.resolve();
			await Promise.all([oldSave, queuedBeforeDelete, latestSave]);
		}
		for (const [, data] of mocks.writeTextFile.mock.calls.slice(1)) {
			expect(JSON.parse(data).assetsByFolder.folder).toBeUndefined();
			expect(JSON.parse(data).foldersByLib.lib.map((folder: SharedFolderInfo) => folder.id)).toEqual(["sibling"]);
		}
		mocks.readTextFile.mockResolvedValue(persisted);
		useSharedLibStore.setState({ initialized: false, libs: [], foldersByLib: {}, assetsByFolder: {}, lastView: null });
		await state.init();
		expect(useSharedLibStore.getState().assetsByFolder.folder).toBeUndefined();
		expect(useSharedLibStore.getState().libs[0]).toMatchObject({ folderCount: 1, assetCount: 1 });
		expect(useSharedLibStore.getState().lastView).toEqual({ libId: "lib" });
	});

	it("前次缓存写入失败后继续保存后续删除状态", async () => {
		vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
		const firstWrite = deferred<void>();
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		mocks.writeTextFile.mockReturnValueOnce(firstWrite.promise).mockResolvedValue(undefined);
		const state = useSharedLibStore.getState();
		const oldSave = state.save();
		await vi.waitFor(() => expect(mocks.writeTextFile).toHaveBeenCalledTimes(1));
		state.removeAsset("folder", "a");
		const latestSave = state.save();
		firstWrite.reject(new Error("disk temporarily unavailable"));
		await Promise.all([oldSave, latestSave]);
		expect(warning).toHaveBeenCalledWith("[sharedLib] save failed:", expect.any(Error));
		const writes = mocks.writeTextFile.mock.calls;
		const persisted = JSON.parse(writes[writes.length - 1][1]);
		expect(persisted.assetsByFolder.folder.map((record: SharedAssetRecord) => record.id)).toEqual(["b"]);
		expect(persisted.libs[0].assetCount).toBe(5);
		expect(mocks.writeTextFile).toHaveBeenCalledTimes(3);
	});
});
