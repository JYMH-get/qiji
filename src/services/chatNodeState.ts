import { create } from "zustand";
import { useCanvasStore } from "@/store/canvasStore";
import { useProjectStore } from "@/store/projectStore";
import { makeNode, avoidOverlap } from "@/canvas/nodeFactory";
import { genId } from "@/lib/id";
import type { CanvasNode, NodeData, NodeRuntime } from "@/types";

export interface ChatContext { projectInstanceId: string; canvasKey: string; nodeId: string }
export interface ChatImage { id?: string; url: string; name?: string }
export interface ChatDraft { text: string; images: ChatImage[] }

export function activeChatCanvasKey(): string {
	const p = useProjectStore.getState();
	return p.canvasEpisodeId && p.episodes.some((e) => e.id === p.canvasEpisodeId)
		? p.canvasEpisodeId : p.episodes[0]?.id ?? "";
}

export function captureChatContext(nodeId: string): ChatContext {
	return { projectInstanceId: useProjectStore.getState().projectInstanceId, canvasKey: activeChatCanvasKey(), nodeId };
}

function target(ctx: ChatContext) {
	const ps = useProjectStore.getState();
	if (ps.projectInstanceId !== ctx.projectInstanceId || ps.isProjectLoading || !ps.episodes.some((e) => e.id === ctx.canvasKey)) return null;
	const active = activeChatCanvasKey() === ctx.canvasKey;
	const canvas = active ? useCanvasStore.getState() : ps.canvases[ctx.canvasKey];
	const node = canvas?.nodes[ctx.nodeId];
	return node?.type === "ai.chat" ? { ps, active, canvas, node } : null;
}

export function readChatNode(ctx: ChatContext): CanvasNode | undefined { return target(ctx)?.node; }

export function patchChatNode(ctx: ChatContext, mutate: (data: NodeData) => NodeData): boolean {
	const t = target(ctx);
	if (!t) return false;
	const nodes = { ...t.canvas.nodes, [ctx.nodeId]: { ...t.node, data: mutate(t.node.data) } };
	if (t.active) useCanvasStore.setState({ nodes });
	else useProjectStore.setState({ canvases: { ...t.ps.canvases, [ctx.canvasKey]: { ...t.canvas, nodes } }, isDirty: true });
	changed(ctx, t.active);
	return true;
}

function changed(ctx: ChatContext, active: boolean): void {
	useProjectStore.getState().scheduleAutoSave("canvas");
	if (!active) void import("@/services/projectSync").then((m) => {
		if (useProjectStore.getState().projectInstanceId === ctx.projectInstanceId) m.broadcastCanvasSnapshot(ctx.canvasKey);
	}).catch(() => {});
}

export function setChatRuntime(ctx: ChatContext, patch: Partial<NodeRuntime>): void {
	if (target(ctx)?.active) useCanvasStore.getState().setRuntime(ctx.nodeId, patch);
}

function imagesOf(value: unknown): ChatImage[] {
	return Array.isArray(value) ? value.filter((v) => v && typeof v.url === "string" && v.url).map((v) => ({
		url: v.url, ...(typeof v.id === "string" ? { id: v.id } : {}), ...(typeof v.name === "string" ? { name: v.name } : {}),
	})) : [];
}

export function readChatDraft(params: Record<string, unknown>): ChatDraft {
	const draft = params.chatDraft as Partial<ChatDraft> | undefined;
	return { text: typeof draft?.text === "string" ? draft.text : String(params.question ?? params.prompt ?? ""),
		images: imagesOf(draft ? draft.images : params.images) };
}

export function updateChatDraft(ctx: ChatContext, mutate: (draft: ChatDraft) => ChatDraft): boolean {
	const node = readChatNode(ctx);
	if (!node || node.data.params.questionLocked || node.data.task) return false;
	const status = target(ctx)?.active ? useCanvasStore.getState().runtime[ctx.nodeId]?.status : undefined;
	if (status === "queued" || status === "running") return false;
	return patchChatNode(ctx, (data) => {
		const draft = mutate(readChatDraft(data.params));
		return { ...data, params: { ...data.params, chatDraft: { text: draft.text, images: imagesOf(draft.images) } } };
	});
}

/** One atomic canvas update makes recovery/repeated delivery create at most one follow-up. */
export function finishChatReply(ctx: ChatContext, taskId: string, text: string): boolean {
	const t = target(ctx);
	if (!t || (t.node.data.task && t.node.data.task.taskId !== taskId)) return false;
	if (t.node.data.params.chatReplyTaskId === taskId) return true;
	const params: Record<string, unknown> = { ...t.node.data.params, questionLocked: true, chatReplyTaskId: taskId, chatReplyFinishedAt: Date.now() };
	delete params.chatDraft;
	const data = { ...t.node.data, params, resultText: text };
	delete data.task;
	const nodes = { ...t.canvas.nodes, [ctx.nodeId]: { ...t.node, data } };
	const edges = { ...t.canvas.edges };
	if (!Object.values(edges).some((e) => e.source === ctx.nodeId && nodes[e.target]?.type === "ai.chat")) {
		const child = avoidOverlap(makeNode("ai.chat", t.node.x + t.node.w + 90, t.node.y), Object.values(nodes));
		child.parentScriptId = ctx.nodeId;
		child.data.params = { ...child.data.params, model: t.node.data.params.model ?? "" };
		nodes[child.id] = child;
		const id = genId("edge");
		edges[id] = { id, kind: "dataflow", source: ctx.nodeId, sourcePort: "out", target: child.id, targetPort: "in" };
	}
	if (t.active) useCanvasStore.setState({ nodes, edges });
	else useProjectStore.setState({ canvases: { ...t.ps.canvases, [ctx.canvasKey]: { ...t.canvas, nodes, edges } }, isDirty: true });
	setChatRuntime(ctx, { status: "success", progress: 100, taskId: null, error: null, partialText: undefined });
	changed(ctx, t.active);
	return true;
}

interface UploadState { busy: boolean; error: string | null }
export const chatContextKey = (ctx: ChatContext): string => JSON.stringify([ctx.projectInstanceId, ctx.canvasKey, ctx.nodeId]);
export const useChatUploadStore = create<{ entries: Record<string, UploadState> }>(() => ({ entries: {} }));
function uploadState(ctx: ChatContext, state: UploadState): void {
	useChatUploadStore.setState((s) => ({ entries: { ...s.entries, [chatContextKey(ctx)]: state } }));
}

/** Upload belongs to its original node even if the panel is unmounted or another episode is selected. */
export async function uploadChatImages(ctx: ChatContext, files: File[], upload: (file: File) => Promise<{ id?: string; url: string }>): Promise<void> {
	if (!readChatNode(ctx) || useChatUploadStore.getState().entries[chatContextKey(ctx)]?.busy) return;
	uploadState(ctx, { busy: true, error: null });
	const errors: string[] = [];
	try {
		for (const file of files) {
			if (!readChatNode(ctx)) break;
			if (!file.type.startsWith("image/")) continue;
			try {
				const result = await upload(file);
				const saved = updateChatDraft(ctx, (d) => ({ ...d, images: [...d.images, { ...result, name: file.name }] }));
				if (saved && result.id) useProjectStore.getState().registerAssetBlob({ id: result.id, url: result.url, mime: file.type });
			} catch { errors.push(file.name || "图片"); }
		}
	} finally {
		uploadState(ctx, { busy: false, error: errors.length ? `${errors.join("、")} 上传失败，请重试。` : null });
	}
}
