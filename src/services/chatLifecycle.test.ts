import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { CanvasNode } from "@/types";
import type { TaskUpdate } from "@/services/taskCenter";

const io = vi.hoisted(() => ({ submit: vi.fn(), handlers: new Map<string, TaskUpdate>(), save: vi.fn(), sync: vi.fn(), writer: true }));
vi.mock("@/services/modelAdapter", () => ({
	getAdapter: () => ({ key: "fixture-chat", submit: io.submit }), registerAdapter: vi.fn(),
}));
vi.mock("@/services/adapters/registry", () => ({ getAdapter: () => ({ key: "fixture-chat", submit: io.submit }), registerAdapter: vi.fn() }));
vi.mock("@/services/adapters/channelAdapter", () => ({ resolveActiveModelKey: () => "fixture-chat" }));
vi.mock("@/services/taskCenter", () => ({ trackTask: (input: { taskId: string; onUpdate: TaskUpdate }) => io.handlers.set(input.taskId, input.onUpdate) }));
vi.mock("@/services/projectSync", () => ({ broadcastCanvasSnapshot: io.sync }));
vi.mock("@/store/debouncedSave", () => ({ initDebouncedSave: vi.fn(), scheduleSave: vi.fn(), notifySaved: vi.fn(), flushScheduledSave: vi.fn(), getSaveRevision: () => 0, cancelAllSaves: vi.fn() }));
vi.mock("@/services/windowSync", () => ({ isProjectWriter: () => io.writer, isPrimaryWindow: () => true, peersHaveProject: () => false }));
vi.mock("@tauri-apps/plugin-fs", () => ({ exists: async () => true }));
vi.mock("@/services/assetRefReport", () => ({ reportProjectAssetRefs: vi.fn(), resetAssetRefThrottle: vi.fn() }));

import { useProjectStore as ps } from "@/store/projectStore";
import { useCanvasStore as cs } from "@/store/canvasStore";
import { defaultNodeExecute } from "@/nodes/pluginRegistry";
import * as nodePlugins from "@/nodes/pluginRegistry";
import { attemptDeliverAll, registerCanvasLedgerTask, useRequestLedgerStore as ls } from "@/store/requestLedgerStore";
import { captureChatContext, chatContextKey, readChatDraft, updateChatDraft, uploadChatImages, useChatUploadStore } from "./chatNodeState";

const node = (id = "chat", answer = "Old useful answer"): CanvasNode => ({ id, type: "ai.chat", x: 0, y: 0, w: 240, h: 280,
	parentId: null, parentScriptId: null, data: { input: {}, params: { question: "Synthetic question", model: "fixture-chat", questionLocked: !!answer }, resultAssetId: null, resultText: answer } });
const canvas = (nodes: Record<string, CanvasNode> = {}) => ({ nodes, edges: {}, groups: {}, viewport: { x: 0, y: 0, zoom: 1 } });
const episodes = ["first", "second"].map((id, i) => ({ id, index: i + 1, title: id, scriptText: "", shots: [] }));
const checkpoint = () => JSON.parse(JSON.stringify({ ...ps.getState().canvases, [ps.getState().canvasEpisodeId!]: canvas(cs.getState().nodes) }));
const pollReady = async (id = "task-one") => { await vi.waitFor(() => expect(io.handlers.has(id), JSON.stringify(cs.getState().runtime)).toBe(true)); };
const update = (status: string, text?: string, error?: string, partial?: string) => io.handlers.get("task-one")!(50, status, text, error, undefined, partial);

beforeEach(() => {
	vi.stubGlobal("window", { __TAURI_INTERNALS__: {}, addEventListener: vi.fn() });
	vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
	io.submit.mockReset().mockResolvedValue({ taskId: "task-one" }); io.handlers.clear(); io.sync.mockClear();
	io.writer = true;
	io.save.mockReset().mockImplementation(async () => { ps.setState({ isDirty: false }); });
	ps.setState({ savePath: "D:/fixture/A.Qiji", name: "A", projectInstanceId: "instance-A", isProjectLoading: false,
		canvasEpisodeId: "first", episodes, canvases: { first: canvas(), second: canvas() }, save: io.save });
	cs.setState({ ...canvas({ chat: node() }), runtime: {}, past: [], future: [] });
	ls.setState({ entries: [] }); useChatUploadStore.setState({ entries: {} });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("chat execution through the real purpose runner and ledger", () => {
	it("checkpoints accepted credentials, retains old answer while streaming, and keeps it on failure", async () => {
		const run = defaultNodeExecute("chat"); await pollReady();
		expect(cs.getState().nodes.chat.data.task).toMatchObject({ taskId: "task-one", adapterKey: "fixture-chat" });
		await vi.waitFor(() => expect(io.save).toHaveBeenCalled());
		expect(ls.getState().entries[0]).toMatchObject({ projectPath: "D:/fixture/A.Qiji", canvasKey: "first", nodeId: "chat", displayKind: "chat" });
		update("running", undefined, undefined, "Unfinished replacement");
		expect(cs.getState().nodes.chat.data.resultText).toBe("Old useful answer");
		expect(cs.getState().runtime.chat.partialText).toBe("Unfinished replacement");
		update("failed", undefined, "synthetic failure"); await run;
		expect(cs.getState().nodes.chat.data.resultText).toBe("Old useful answer");
		expect(cs.getState().nodes.chat.data.task).toBeUndefined();
		expect(cs.getState().runtime.chat).toMatchObject({ status: "failed", error: "synthetic failure", partialText: undefined });
		expect(ls.getState().entries).toHaveLength(0);
	});

	it("reconnects a lost task without resubmission, restores persisted credentials and creates one continuation", async () => {
		const first = defaultNodeExecute("chat"); await pollReady();
		update("lost", undefined, "temporary disconnect"); await first;
		expect(cs.getState().nodes.chat.data.task?.taskId).toBe("task-one");
		expect(ls.getState().entries).toHaveLength(1);
		const reopened = checkpoint();
		ps.setState({ projectInstanceId: "instance-reopened", canvases: reopened });
		cs.setState({ ...reopened.first, runtime: {} }); io.handlers.clear();
		const resume = defaultNodeExecute("chat"); await pollReady();
		expect(io.submit).toHaveBeenCalledTimes(1);
		update("success", "Recovered answer"); await resume;
		expect(cs.getState().nodes.chat.data).toMatchObject({ resultText: "Recovered answer", params: { questionLocked: true, chatReplyTaskId: "task-one" } });
		expect(cs.getState().nodes.chat.data.task).toBeUndefined();
		expect(Object.values(cs.getState().edges)).toHaveLength(1);
		await registerCanvasLedgerTask({ taskId: "task-one", adapterKey: "fixture-chat", nodeId: "chat", nodeType: "ai.chat", nodeTitle: "same title", displayKind: "chat" });
		ls.setState({ entries: ls.getState().entries.map((e) => ({ ...e, status: "done", result: { text: "Recovered answer" } })) });
		await attemptDeliverAll("task-one");
		expect(Object.values(cs.getState().edges)).toHaveLength(1);
	});

	it("finishes in the original inactive episode, ignoring a copied node id in the active episode", async () => {
		const run = defaultNodeExecute("chat"); await pollReady();
		const saved = canvas(cs.getState().nodes);
		ps.setState({ canvases: { first: saved, second: canvas() }, canvasEpisodeId: "second" });
		cs.setState({ ...canvas({ chat: node("chat", "Second episode answer") }), runtime: {} });
		update("running", undefined, undefined, "must stay original");
		update("success", "First episode answer"); await run;
		expect(cs.getState().nodes.chat.data.resultText).toBe("Second episode answer");
		expect(cs.getState().runtime.chat).toBeUndefined();
		const original = ps.getState().canvases.first;
		expect(original.nodes.chat.data).toMatchObject({ resultText: "First episode answer", params: { questionLocked: true } });
		expect(Object.values(original.edges)).toHaveLength(1);
		expect(Object.values(original.nodes)).toHaveLength(2);
	});

	it("late submit acknowledgement caches the original project receipt and never changes the new project", async () => {
		let accept!: (value: { taskId: string }) => void;
		io.submit.mockImplementation(() => new Promise((resolve) => { accept = resolve; }));
		cs.getState().nodes.chat.data.params.chatReplyTaskId = "previous-task";
		cs.getState().nodes.chat.data.params.chatReplyFinishedAt = Date.now() - 5000;
		const original = canvas(cs.getState().nodes);
		const run = defaultNodeExecute("chat"); await vi.waitFor(() => expect(io.submit).toHaveBeenCalled());
		ps.setState({ savePath: "D:/fixture/B.Qiji", name: "B", projectInstanceId: "instance-B" });
		cs.setState({ ...canvas({ chat: node("chat", "B answer") }), runtime: {} });
		accept({ taskId: "task-one" }); await pollReady();
		expect(cs.getState().nodes.chat.data.task).toBeUndefined();
		update("success", "A answer"); await run;
		expect(cs.getState().nodes.chat.data.resultText).toBe("B answer");
		expect(cs.getState().runtime.chat).toBeUndefined();
		expect(ls.getState().entries[0]).toMatchObject({ projectPath: "D:/fixture/A.Qiji", status: "done", result: { text: "A answer" } });
		ps.setState({ savePath: "D:/fixture/A.Qiji", projectInstanceId: "instance-A-reopened" });
		cs.setState({ ...original, runtime: {} });
		await attemptDeliverAll("task-one");
		expect(cs.getState().nodes.chat.data.resultText).toBe("A answer");
	});

	it("keeps the completed receipt when a checkpoint fails and retries without a second continuation", async () => {
		const run = defaultNodeExecute("chat"); await pollReady();
		await vi.waitFor(() => expect(io.save).toHaveBeenCalledTimes(1));
		io.save.mockImplementationOnce(async () => { ps.setState({ isDirty: true }); });
		update("success", "Durable after retry"); await run;
		expect(ls.getState().entries[0]?.status).toBe("done");
		expect(Object.values(cs.getState().edges)).toHaveLength(1);
		await attemptDeliverAll("task-one");
		expect(ls.getState().entries).toHaveLength(0);
		expect(Object.values(cs.getState().edges)).toHaveLength(1);
		expect(cs.getState().nodes.chat.data.resultText).toBe("Durable after retry");
	});

	it("does not deliver an unsaved project's receipt into a different unsaved project", async () => {
		ps.setState({ savePath: null });
		await registerCanvasLedgerTask({ taskId: "unsaved", adapterKey: "fixture-chat", nodeId: "chat", nodeType: "ai.chat", nodeTitle: "same title", displayKind: "chat",
			identity: { projectPath: "", projectName: "A", projectInstanceId: "instance-A", canvasKey: "first" } });
		ls.setState({ entries: ls.getState().entries.map((e) => ({ ...e, status: "done", result: { text: "Original unsaved answer" } })) });
		ps.setState({ projectInstanceId: "unsaved-B" });
		await attemptDeliverAll("unsaved");
		expect(cs.getState().nodes.chat.data.resultText).toBe("Old useful answer");
		expect(ls.getState().entries[0]?.status).toBe("done");
		ps.setState({ projectInstanceId: "instance-A" });
		await attemptDeliverAll("unsaved");
		expect(cs.getState().nodes.chat.data.resultText).toBe("Original unsaved answer");
	});

	it("retains a follower window receipt until this window can confirm a writer checkpoint", async () => {
		io.writer = false;
		const run = defaultNodeExecute("chat"); await pollReady(); update("success", "Follower answer"); await run;
		expect(ps.getState().isDirty).toBe(false);
		expect(ls.getState().entries[0]?.status).toBe("done");
		expect(Object.values(cs.getState().edges)).toHaveLength(1);
		io.writer = true;
		await attemptDeliverAll("task-one");
		expect(ls.getState().entries).toHaveLength(0);
		expect(Object.values(cs.getState().edges)).toHaveLength(1);
	});

	it("rechecks unsaved project ownership after awaiting the delivery setup", async () => {
		ps.setState({ savePath: null });
		await registerCanvasLedgerTask({ taskId: "unsaved-race", adapterKey: "fixture-chat", nodeId: "chat", nodeType: "ai.chat", nodeTitle: "same title", displayKind: "chat",
			identity: { projectPath: "", projectName: "A", projectInstanceId: "instance-A", canvasKey: "first" } });
		ls.setState({ entries: ls.getState().entries.map((e) => ({ ...e, status: "done", result: { text: "Original project answer" } })) });
		// The outer context check has passed. Queue a project switch across the next awaited import.
		const tracked = vi.spyOn(nodePlugins, "isCanvasTaskTracked").mockImplementationOnce(() => {
			queueMicrotask(() => {
				ps.setState({ projectInstanceId: "imported-B" });
				cs.setState({ ...canvas({ chat: node("chat", "Imported project answer") }), runtime: {} });
			});
			return false;
		});
		await attemptDeliverAll();
		expect(tracked).toHaveBeenCalledWith("unsaved-race");
		expect(ps.getState().projectInstanceId).toBe("imported-B");
		expect(cs.getState().nodes.chat.data.resultText).toBe("Imported project answer");
		expect(Object.values(cs.getState().edges)).toHaveLength(0);
		expect(ls.getState().entries[0]?.status).toBe("done");
	});
});

describe("persisted chat drafts and uploads", () => {
	it("keeps text and attachment descriptors through selection and serialized reopen", () => {
		cs.setState({ nodes: { chat: node("chat", ""), other: node("other", "") } });
		const ctx = captureChatContext("chat");
		updateChatDraft(ctx, () => ({ text: "Unsent question", images: [{ id: "image-one", url: "https://example.invalid/one.png", name: "one.png", previewUrl: "data:must-not-persist" } as never] }));
		updateChatDraft(captureChatContext("other"), () => ({ text: "Other draft", images: [] }));
		const stored = JSON.stringify(cs.getState().nodes);
		expect(stored).not.toContain("data:must-not-persist");
		ps.setState({ projectInstanceId: "reopened" }); cs.setState({ nodes: JSON.parse(stored) });
		expect(readChatDraft(cs.getState().nodes.chat.data.params)).toEqual({ text: "Unsent question", images: [{ id: "image-one", url: "https://example.invalid/one.png", name: "one.png" }] });
		expect(readChatDraft(cs.getState().nodes.other.data.params).text).toBe("Other draft");
		expect(updateChatDraft(ctx, () => ({ text: "late old callback", images: [] }))).toBe(false);
	});

	it("reports failed attachments and appends successful uploads to the originating inactive node", async () => {
		cs.setState({ nodes: { chat: node("chat", "") } });
		const ctx = captureChatContext("chat");
		let finish!: (value: { url: string }) => void;
		const upload = vi.fn().mockRejectedValueOnce(Error("synthetic upload error")).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
		const files = ["bad.png", "good.png"].map((name) => ({ name, type: "image/png" } as File));
		const pending = uploadChatImages(ctx, files, upload);
		await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
		ps.setState({ canvasEpisodeId: "second", canvases: { first: canvas(cs.getState().nodes), second: canvas() } });
		cs.setState(canvas({ chat: node("chat", "") }));
		finish({ url: "https://example.invalid/good.png" }); await pending;
		expect(readChatDraft(ps.getState().canvases.first.nodes.chat.data.params).images).toHaveLength(1);
		expect(readChatDraft(cs.getState().nodes.chat.data.params).images).toHaveLength(0);
		expect(useChatUploadStore.getState().entries[chatContextKey(ctx)]).toEqual({ busy: false, error: "bad.png 上传失败，请重试。" });
	});

	it("drops upload completion after a project switch with identical node ids", async () => {
		cs.setState({ nodes: { chat: node("chat", "") } }); const ctx = captureChatContext("chat");
		let finish!: (value: { url: string }) => void;
		const upload = uploadChatImages(ctx, [{ name: "old.png", type: "image/png" } as File], () => new Promise((resolve) => { finish = resolve; }));
		ps.setState({ projectInstanceId: "instance-B" });
		finish({ url: "https://example.invalid/old.png" }); await upload;
		expect(readChatDraft(cs.getState().nodes.chat.data.params).images).toHaveLength(0);
	});
});
