import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncMsg } from "@/lib/projectSyncCore";
import type { Asset } from "@/store/libraryStore";

const io = vi.hoisted(() => ({
	read: vi.fn(), write: vi.fn(), emit: vi.fn(), upload: vi.fn(),
	receive: undefined as undefined | ((event: { payload: Record<string, unknown> }) => void),
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
	readTextFile: io.read, writeTextFile: io.write, exists: async () => true,
	mkdir: vi.fn(), rename: vi.fn(), remove: vi.fn(),
	copyFile: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => "D:/fixture/source.Qiji" }));
vi.mock("./webdavSync", () => ({ uploadProjectFile: io.upload }));
vi.mock("@tauri-apps/api/path", () => ({ join: async (...parts: string[]) => parts.join("/") }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (path: string) => `asset:${path}` }));
vi.mock("@tauri-apps/api/event", () => ({
	emit: io.emit,
	listen: async (_name: string, receive: typeof io.receive) => { io.receive = receive; return () => {}; },
}));
vi.mock("@/services/clientDiagnostics", () => ({
	recordClientDiagnostic: vi.fn(), classifyClientDiagnosticError: () => "unknown",
}));
vi.mock("@/services/projectAssetHeal", () => ({ healProjectAssetBlobs: vi.fn() }));
vi.mock("@/services/libraryHeal", () => ({ healLibraryAssets: vi.fn() }));
vi.mock("@/services/assetRefReport", () => ({ resetAssetRefThrottle: vi.fn(), reportProjectAssetRefs: vi.fn() }));
vi.mock("@/services/generationQueue", () => ({ resumePendingGenerations: vi.fn() }));
vi.mock("@/services/inferRun", () => ({ resumeInferTasks: vi.fn() }));
vi.mock("@/nodes/pluginRegistry", () => ({ resumeCanvasNodeTasks: vi.fn() }));
vi.mock("@/store/requestLedgerStore", () => ({ onProjectContextChanged: vi.fn() }));
vi.mock("@/popout/popout", () => ({ isPopout: () => false }));

const A = "D:/fixture/a/project.Qiji";
const B = "D:/fixture/b/project.Qiji";
const asset: Asset = {
	id: "from-A", kind: "image", name: "A image", uri: "https://example.invalid/a.png",
	createdAt: "2026-10-04T00:00:00.000Z", deletedByUser: false,
	serverAssetId: null, thumbnailUri: null, localPath: null,
};
const emptyCanvas = () => ({ nodes: {}, edges: {}, groups: {}, viewport: { x: 0, y: 0, zoom: 1 } });
function document(name: string, assets: Record<string, Asset> = {}) {
	return {
		version: "2.0", name, head: "head", activeCanvasKey: "first",
		episodes: ["first", "second"].map((id, i) => ({ id, index: i + 1, title: id, scriptText: "", shots: [] })),
		canvases: { first: emptyCanvas(), second: emptyCanvas() },
		commits: { head: { commitId: "head", parentIds: [], message: "fixture", author: "test",
			timestamp: "2026-10-04T00:00:00.000Z", canvas: emptyCanvas(), assets } },
	};
}

let ps: typeof import("@/store/projectStore").useProjectStore;
let cs: typeof import("@/store/canvasStore").useCanvasStore;
let lib: typeof import("@/store/libraryStore").useLibraryStore;
let sync: typeof import("./projectSync");
let transport: typeof import("./windowSync");
let cancelSaves: typeof import("@/store/debouncedSave").cancelAllSaves;

function envelopes() { return io.emit.mock.calls.map(([, envelope]) => envelope); }
function messages(): SyncMsg[] { return envelopes().flatMap((e) => e.payload ? [e.payload as SyncMsg] : []); }
function peer(path: string, message?: SyncMsg) {
	io.receive!({ payload: { senderId: `peer:${path}`, senderOpenedAt: transport.openedAt - 10_000,
		senderProject: path, senderCanvasKey: "first", ...(message ? { payload: message } : {}) } });
}
async function startSync() {
	sync.initProjectSync();
	await vi.dynamicImportSettled();
	io.emit.mockClear();
}

beforeEach(async () => {
	vi.resetModules();
	vi.useFakeTimers();
	io.read.mockReset(); io.write.mockReset(); io.emit.mockReset(); io.upload.mockReset().mockResolvedValue(undefined); io.receive = undefined;
	vi.stubGlobal("window", { __TAURI_INTERNALS__: {}, addEventListener: vi.fn() });
	vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
	({ useProjectStore: ps } = await import("@/store/projectStore"));
	({ useCanvasStore: cs } = await import("@/store/canvasStore"));
	({ useLibraryStore: lib } = await import("@/store/libraryStore"));
	({ cancelAllSaves: cancelSaves } = await import("@/store/debouncedSave"));
	sync = await import("./projectSync");
	transport = await import("./windowSync");
	const { useSettingsStore } = await import("@/store/settingsStore");
	useSettingsStore.setState({ enableCloudSync: false });
	vi.spyOn(useSettingsStore.getState(), "setLastOpenedProjectPath").mockImplementation(() => {});
	ps.setState({ savePath: A, projectInstanceId: "a", name: "A", isProjectLoading: false,
		canvasEpisodeId: "first", episodes: document("A").episodes, canvases: document("A").canvases });
	cs.setState({ ...emptyCanvas(), runtime: {}, past: [], future: [] });
	lib.setState({ assets: {} });
	io.read.mockResolvedValue(JSON.stringify(document("B")));
});
afterEach(() => {
	cancelSaves(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe("项目加载与真实多窗口同步", () => {
	it("加载B后身份和hello归B，已有B写者时保存转发而不写本地文件", async () => {
		await startSync(); peer(B);
		expect(await ps.getState().loadFromPath(B)).toBe(true);
		const hello = envelopes().find((e) => e.payload?.type === "hello");
		expect(hello).toMatchObject({ senderProject: B, senderCanvasKey: "first", payload: { projectPath: B } });
		expect(transport.isProjectWriter()).toBe(false);
		await ps.getState().save(true);
		await vi.dynamicImportSettled();
		expect(io.write).not.toHaveBeenCalled();
		expect(messages()).toContainEqual(expect.objectContaining({ type: "save-request", projectPath: B }));
		peer(B, { type: "full", senderId: `peer:${B}`, projectPath: B, targetId: transport.windowId,
			fields: { name: "B writer memory" }, canvases: document("B").canvases,
			library: { [asset.id]: asset }, runtimes: {} });
		expect(ps.getState().name).toBe("B writer memory");
		expect(lib.getState().assets[asset.id]).toEqual(asset);
		await vi.advanceTimersByTimeAsync(300);
		expect(messages().some((m) => ["canvas", "fields", "library"].includes(m.type))).toBe(false);
	});

	it("同路径重新打开也在hydration完成后重新hello", async () => {
		await startSync(); peer(A);
		io.read.mockResolvedValue(JSON.stringify(document("A reopened")));
		expect(await ps.getState().loadFromPath(A)).toBe(true);
		expect(ps.getState().projectInstanceId).not.toBe("a");
		expect(messages().filter((m) => m.type === "hello")).toEqual([
			expect.objectContaining({ projectPath: A }),
		]);
		expect(transport.isProjectWriter()).toBe(false);
	});

	it("同步初始化遇到加载进行中时等就绪才报到", async () => {
		let finish!: (text: string) => void;
		io.read.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
		const loading = ps.getState().loadFromPath(B);
		await vi.dynamicImportSettled();
		await startSync();
		expect(messages()).toHaveLength(0);
		finish(JSON.stringify(document("B")));
		await loading;
		expect(messages().filter((m) => m.type === "hello")).toEqual([
			expect.objectContaining({ projectPath: B }),
		]);
	});

	it("失败加载交出旧项目待同步编辑，再以原身份恢复握手", async () => {
		await startSync(); peer(A);
		ps.getState().setName("A unsaved edit");
		lib.setState({ assets: { [asset.id]: asset } });
		io.read.mockRejectedValue(new Error("missing fixture"));
		vi.spyOn(console, "error").mockImplementation(() => {});
		expect(await ps.getState().loadFromPath(B)).toBe(false);
		expect(ps.getState()).toMatchObject({ savePath: A, projectInstanceId: "a", name: "A unsaved edit" });
		expect(messages()).toContainEqual(expect.objectContaining({ type: "fields", projectPath: A, fields: { name: "A unsaved edit" } }));
		expect(messages()).toContainEqual(expect.objectContaining({ type: "library", projectPath: A, assets: { [asset.id]: asset } }));
		expect(messages()).toContainEqual(expect.objectContaining({ type: "hello", projectPath: A }));
		expect(transport.isProjectWriter()).toBe(false);
		const count = messages().length;
		await vi.advanceTimersByTimeAsync(300);
		expect(messages()).toHaveLength(count);
	});

	it("旧排队广播只发给A，加载期间静默，B相同分集id不继承A的runtime", async () => {
		await startSync(); peer(A); peer(B);
		peer(A, { type: "runtime", senderId: `peer:${A}`, projectPath: A,
			canvasKey: "second", runtime: { "old-node": { progress: 90 } } });
		ps.getState().setName("A queued");
		cs.setState({ nodes: {} });
		cs.getState().setRuntime("local-old", { progress: 50 });
		lib.setState({ assets: { [asset.id]: asset } });
		let finish!: (text: string) => void;
		io.read.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
		const loading = ps.getState().loadFromPath(B);
		await vi.dynamicImportSettled();
		expect(messages().map((m) => m.type).sort()).toEqual(["canvas", "fields", "library"]);
		expect(messages().every((m) => m.projectPath === A)).toBe(true);
		io.emit.mockClear();
		lib.setState({ assets: {} });
		cs.getState().setRuntime("loading", { progress: 75 });
		await vi.advanceTimersByTimeAsync(300);
		expect(messages()).toHaveLength(0);
		finish(JSON.stringify(document("B")));
		await loading;
		await vi.advanceTimersByTimeAsync(300);
		expect(messages().map((m) => m.type)).toEqual(["hello"]);
		ps.getState().switchCanvas("second");
		expect(cs.getState().runtime).toEqual({});
		await vi.dynamicImportSettled();
	});
});

describe("项目加载替换素材库", () => {
	it.each(["empty-head", "missing-library", "empty-head-with-legacy"])("%s 不沿用A素材，B保存也为空", async (kind) => {
		await startSync();
		lib.setState({ assets: { [asset.id]: asset } });
		const data: ReturnType<typeof document> & { assets?: Record<string, Asset> } = document("B");
		if (kind === "missing-library") delete (data.commits.head as { assets?: Record<string, Asset> }).assets;
		if (kind === "empty-head-with-legacy") data.assets = { legacy: { ...asset, id: "legacy" } };
		io.read.mockResolvedValue(JSON.stringify(data));
		await ps.getState().loadFromPath(B);
		expect(lib.getState().assets).toEqual({});
		await ps.getState().save(true);
		expect(io.write).toHaveBeenCalledTimes(1);
		const saved = JSON.parse(io.write.mock.calls[0][1]);
		expect(saved.commits[saved.head].assets).toEqual({});
	});

	it("只有缺少新格式素材字段时才载入旧格式素材库", async () => {
		await startSync();
		const data = document("B");
		delete (data.commits.head as { assets?: Record<string, Asset> }).assets;
		io.read.mockResolvedValue(JSON.stringify({ ...data, assets: { [asset.id]: asset } }));
		await ps.getState().loadFromPath(B);
		expect(lib.getState().assets).toEqual({ [asset.id]: asset });
	});
});

describe("项目云备份身份与实际保存", () => {
	it("本地落盘后才排队云备份，云端使用项目身份", async () => {
		await ps.getState().loadFromPath(B);
		const { useSettingsStore } = await import("@/store/settingsStore");
		useSettingsStore.setState({ enableCloudSync: true, webdavUrl: "https://backup.invalid", webdavDirectory: "/qiji" });
		await ps.getState().save(true);
		expect(io.write).toHaveBeenCalledTimes(1);
		expect(io.upload).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(2000);
		expect(io.upload).toHaveBeenCalledTimes(1);
		expect(io.upload.mock.calls[0][1]).toBe(`${ps.getState().cloudBackupId}.Qiji`);
		expect(io.upload.mock.calls[0][2]).toBe(io.write.mock.calls[0][1]);
	});

	it("导入副本重新分配身份，源文件只读", async () => {
		const { useSettingsStore } = await import("@/store/settingsStore");
		vi.spyOn(useSettingsStore.getState(), "getActiveUserDataDir").mockResolvedValue("D:/fixture/user");
		const source = "D:/fixture/source.Qiji";
		io.read.mockImplementation(async (path: string) => path === source
			? JSON.stringify({ ...document("B"), cloudBackupId: "backup-source" })
			: io.write.mock.calls.find(c => c[0] === path)?.[1]);
		expect(await ps.getState().importProject()).toBe(true);
		expect(ps.getState().cloudBackupId).not.toBe("backup-source");
		expect(io.write.mock.calls.every(c => c[0] !== source)).toBe(true);
		expect(JSON.parse(io.write.mock.calls[0][1]).cloudBackupId).toBe(ps.getState().cloudBackupId);
	});
	it("旧项目首次保存写入独立身份，同名新项目另分配身份", async () => {
		await ps.getState().loadFromPath(B);
		const id = ps.getState().cloudBackupId;
		expect(id).toMatch(/^backup-[a-zA-Z0-9-]+$/);
		await ps.getState().save(true);
		expect(JSON.parse(io.write.mock.calls[0][1]).cloudBackupId).toBe(id);
		ps.getState().newProject();
		expect(ps.getState().cloudBackupId).not.toBe(id);
	});
	it("已有身份随重新打开和改名保留", async () => {
		io.read.mockResolvedValue(JSON.stringify({ ...document("B"), cloudBackupId: "backup-existing" }));
		await ps.getState().loadFromPath(B);
		ps.getState().setName("renamed");
		await ps.getState().save(true);
		expect(JSON.parse(io.write.mock.calls[0][1]).cloudBackupId).toBe("backup-existing");
	});
	it("新项目目录准备期间切换项目，不把旧目录挂到新项目", async () => {
		const { useSettingsStore } = await import("@/store/settingsStore");
		let finish!: (path: string) => void;
		vi.spyOn(useSettingsStore.getState(), "getActiveUserDataDir").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
		ps.setState({ savePath: null });
		const preparing = ps.getState().ensureProjectPath();
		const rejected = expect(preparing).rejects.toThrow("项目已切换");
		ps.setState({ projectInstanceId: "other-project", savePath: B });
		finish("D:/fixture/user");
		await rejected;
		expect(ps.getState().savePath).toBe(B);
	});
});
