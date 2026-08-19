/**
 * windowSync —— 多窗口同步的传输与在场层（第205轮）。
 *
 * 职责：
 *   1. 传输：把同步消息广播给本机同应用的其它窗口——Tauri 下走事件系统（单实例多窗口，
 *      emit 全局广播）；浏览器 dev 走 BroadcastChannel（同源标签页，天然不回声）。
 *   2. 在场（presence）：心跳广播 {windowId, openedAt, projectPath, activeCanvasKey}，
 *      3 个心跳周期没消息的窗口从在场表剔除（关窗/假死自动让位）。
 *   3. 选举（确定性无协商，所有窗口独立算同一结论）：
 *      - **项目写者** isProjectWriter()：同项目窗口里 openedAt 最小者——唯一写盘方；
 *      - **主窗口** isPrimaryWindow()：全部窗口里 openedAt 最小者——请求台账全局兜底方。
 *
 * ⚠ 本模块**不静态依赖任何 store**（projectStore 要静态 import 它做写盘门禁，反向依赖会成环）；
 * 当前项目路径/激活画布由 projectSync 经 setSyncContext 喂入。
 * 未初始化（单测/未登录）时的默认答案 = 单窗口语义：自己就是写者与主窗口，行为与改造前一致。
 */
import {
	type PeerInfo,
	type SyncMsg,
	PEER_HEARTBEAT_MS,
	prunePeers,
	pickLeader,
} from "@/lib/projectSyncCore";

const EVENT_NAME = "qiji://win-sync";

/** 本窗口身份（进程内常量；openedAt 是选举排序主键——先开的窗口当写者/主窗口） */
export const windowId: string =
	typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `w-${Date.now()}-${Math.random()}`;
export const openedAt: number = Date.now();

/** 在场消息（心跳与同步消息共用信封的 presence 部分） */
interface Envelope {
	senderId: string;
	senderOpenedAt: number;
	senderProject: string;
	senderCanvasKey: string;
	/** 心跳无 payload；同步消息带 */
	payload?: SyncMsg;
}

let inited = false;
let ctx = { projectPath: "" as string, activeCanvasKey: "" as string };
const peers = new Map<string, PeerInfo>();
const listeners = new Set<(msg: SyncMsg) => void>();

let sendFn: ((env: Envelope) => void) | null = null;
let hbTimer: ReturnType<typeof setInterval> | null = null;

function isTauri(): boolean {
	return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

/** projectSync 喂入当前项目上下文（心跳携带；选举据此分组） */
export function setSyncContext(patch: Partial<{ projectPath: string; activeCanvasKey: string }>): void {
	ctx = { ...ctx, ...patch };
}

function envelope(payload?: SyncMsg): Envelope {
	return {
		senderId: windowId,
		senderOpenedAt: openedAt,
		senderProject: ctx.projectPath,
		senderCanvasKey: ctx.activeCanvasKey,
		payload,
	};
}

function onEnvelope(env: Envelope): void {
	if (!env || env.senderId === windowId) return; // Tauri emit 会回到自身，按 senderId 过滤
	peers.set(env.senderId, {
		windowId: env.senderId,
		openedAt: env.senderOpenedAt,
		projectPath: env.senderProject ?? "",
		activeCanvasKey: env.senderCanvasKey ?? "",
		lastSeen: Date.now(),
	});
	if (env.payload) {
		for (const fn of listeners) {
			try { fn(env.payload); } catch (e) { console.warn("[windowSync] 消息处理失败：", e); }
		}
	}
}

/** 启动传输 + 心跳（幂等；弹出窗口 popout 只读不参与，由调用方把关） */
export async function initWindowSync(): Promise<void> {
	if (inited) return;
	inited = true;
	if (isTauri()) {
		const { emit, listen } = await import("@tauri-apps/api/event");
		await listen<Envelope>(EVENT_NAME, (e) => onEnvelope(e.payload));
		sendFn = (env) => { void emit(EVENT_NAME, env); };
	} else if (typeof BroadcastChannel !== "undefined") {
		const ch = new BroadcastChannel(EVENT_NAME);
		ch.onmessage = (e) => onEnvelope(e.data as Envelope);
		sendFn = (env) => ch.postMessage(env);
	} else {
		return; // 无可用通道（如单测环境）：保持单窗口语义
	}
	sendFn(envelope()); // 立即报到一次，让先开的窗口尽快知道我在
	hbTimer = setInterval(() => {
		sendFn?.(envelope());
		// 顺手清理超时窗口（选举即时让位）
		const alive = prunePeers([...peers.values()], Date.now());
		peers.clear();
		for (const p of alive) peers.set(p.windowId, p);
	}, PEER_HEARTBEAT_MS);
	// 关窗尽力通知（收不到也有心跳超时兜底）
	window.addEventListener("beforeunload", () => { try { hbTimer && clearInterval(hbTimer); } catch { /* noop */ } });
}

/** 广播一条同步消息给其它窗口 */
export function broadcastSync(msg: SyncMsg): void {
	sendFn?.(envelope(msg));
}

/** 订阅其它窗口的同步消息（返回退订函数） */
export function onSyncMessage(fn: (msg: SyncMsg) => void): () => void {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

/** 当前在场的其它窗口（已剔除超时者） */
export function getPeers(): PeerInfo[] {
	return prunePeers([...peers.values()], Date.now());
}

/** 是否有其它窗口打开着某项目（请求台账据此把该项目的任务让给对方窗口处理） */
export function peersHaveProject(projectPath: string): boolean {
	if (!projectPath) return false;
	return getPeers().some((p) => p.projectPath === projectPath);
}

/**
 * 本窗口是否为**当前项目的写者**（唯一写盘方）。
 * 单窗口/未初始化/项目未落盘 → true（与改造前行为一致：自己保存自己的）。
 */
export function isProjectWriter(): boolean {
	if (!ctx.projectPath) return true;
	const candidates = [
		{ windowId, openedAt },
		...getPeers().filter((p) => p.projectPath === ctx.projectPath),
	];
	return pickLeader(candidates) === windowId;
}

/** 本窗口是否为**主窗口**（全部窗口里最先开的；请求台账的全局兜底轮询/孤儿通知归它） */
export function isPrimaryWindow(): boolean {
	const candidates = [{ windowId, openedAt }, ...getPeers()];
	return pickLeader(candidates) === windowId;
}
