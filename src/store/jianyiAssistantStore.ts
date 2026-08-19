/**
 * jianyiAssistantStore —— 「简一助手」对话状态（多会话 + 会话记忆 + 多窗口/分身）。
 *
 * - 会话管理：可新建 / 重命名 / 删除多个会话（sessions）。
 * - 会话记忆：每个会话的消息历史持久化到 localStorage，重开软件仍在；
 *   发送时把最近若干轮历史一并作为上下文喂给模型（见 JianyiWindow.buildConversationPrompt）。
 * - 多窗口/分身：可同时打开多个简一助手窗口，每个窗口独立浏览/对话一个会话；
 *   故所有写操作都按 sessionId 定位（不再依赖单一 currentId），流式态按 sessionId 记录。
 * - 支持图片：用户消息可携带已上传的图片（id/url）。
 */
import { create } from "zustand";

export interface JyImage {
	/** 管理端分配的资产 id（可选） */
	id?: string;
	/** 公网 url（发给模型用；Tauri CSP 不允许 http(s) 直接 <img>，故展示另用 previewUrl） */
	url: string;
	/** 本地可显示缩略图（data: URL，CSP 允许、可持久化），用于界面展示 */
	previewUrl?: string;
	name?: string;
}

/** 非图片附件（文档/代码/字幕等）。文本类文件抽取正文喂给模型；二进制文件仅上传+按名引用。 */
export interface JyFile {
	/** 管理端分配的资产 id（可选） */
	id?: string;
	/** 公网 url（上传到 OSS 的 TP 临时资产） */
	url: string;
	name: string;
	/** 字节大小（展示用） */
	size?: number;
	/** MIME 类型 */
	mime?: string;
	/** 文本类文件抽取的正文（喂给模型；可能已截断）；二进制文件为空 */
	text?: string;
}

export interface JyMessage {
	id: string;
	role: "user" | "assistant";
	content: string;
	images?: JyImage[];
	/** 非图片附件 */
	files?: JyFile[];
	/** 该条助手消息是否出错（用于红色提示） */
	error?: boolean;
	timestamp: number;
}

export interface JySession {
	id: string;
	title: string;
	messages: JyMessage[];
	/** 该会话选用的文本模型 id（空=用设置里的默认文本模型） */
	model?: string;
	createdAt: number;
	updatedAt: number;
}

interface JyState {
	sessions: JySession[];
	/** 正在流式输出的会话 id 列表（按会话隔离，多窗口互不干扰） */
	streamingIds: string[];

	getSession: (id: string) => JySession | undefined;
	newSession: () => string;
	renameSession: (id: string, title: string) => void;
	deleteSession: (id: string) => void;
	setSessionModel: (id: string, model: string) => void;

	addMessage: (sessionId: string, msg: JyMessage) => void;
	appendToLast: (sessionId: string, full: string) => void;
	finishLast: (sessionId: string, full: string, error?: boolean) => void;
	/** 删除会话末尾的助手消息（若有）——重新回答前清掉旧答案 */
	dropLastAssistant: (sessionId: string) => void;
	/** 回退：删掉末尾「助手回复 + 上一条用户消息」，返回被删的用户文本/图片/附件（供还原到输入框） */
	popLastExchange: (sessionId: string) => { text: string; images?: JyImage[]; files?: JyFile[] } | null;
	clearSession: (sessionId: string) => void;

	setStreaming: (sessionId: string, v: boolean) => void;
}

const STORAGE_KEY = "Qiji:jianyiSessions";

let _seq = 0;
function uid(prefix: string): string {
	_seq += 1;
	return `${prefix}-${Date.now().toString(36)}-${_seq}`;
}

function blankSession(): JySession {
	const now = Date.now();
	return { id: uid("jy"), title: "新对话", messages: [], createdAt: now, updatedAt: now };
}

function load(): JySession[] {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw) {
			const p = JSON.parse(raw) as { sessions?: JySession[] };
			if (Array.isArray(p.sessions) && p.sessions.length) return p.sessions;
		}
	} catch {
		/* ignore */
	}
	return [blankSession()];
}

function persist(sessions: JySession[]) {
	try {
		// 每会话最多保留近 200 条，防止 localStorage 膨胀；附件正文（可能很大）只留最近 20 条，
		// 更早的消息剥掉 file.text（记忆窗口本就只有 12 轮，够用），避免 localStorage 撑爆。
		const slim = {
			sessions: sessions.map((s) => {
				const msgs = s.messages.slice(-200);
				const keepTextFrom = Math.max(0, msgs.length - 20);
				return {
					...s,
					messages: msgs.map((m, i) =>
						i < keepTextFrom && m.files?.some((f) => f.text)
							? { ...m, files: m.files.map((f) => (f.text ? { ...f, text: undefined } : f)) }
							: m,
					),
				};
			}),
		};
		localStorage.setItem(STORAGE_KEY, JSON.stringify(slim));
	} catch {
		/* ignore */
	}
}

/** 用首条用户消息自动命名会话（仍是默认名时） */
function autoTitle(session: JySession): string {
	if (session.title && session.title !== "新对话") return session.title;
	const firstUser = session.messages.find((m) => m.role === "user" && m.content.trim());
	if (!firstUser) return session.title;
	const t = firstUser.content.trim().replace(/\s+/g, " ");
	return t.length > 18 ? `${t.slice(0, 18)}…` : t;
}

/** 对某会话做消息变换并落盘（persist 可关，用于流式中只更内存） */
function mutateSession(
	sessions: JySession[],
	id: string,
	fn: (s: JySession) => JySession,
): JySession[] {
	return sessions.map((s) => (s.id === id ? fn(s) : s));
}

export const useJianyiStore = create<JyState>((set, get) => ({
	sessions: load(),
	streamingIds: [],

	getSession: (id) => get().sessions.find((s) => s.id === id),

	newSession: () => {
		const s = blankSession();
		set((st) => {
			const sessions = [s, ...st.sessions];
			persist(sessions);
			return { sessions };
		});
		return s.id;
	},

	renameSession: (id, title) => {
		set((st) => {
			const sessions = mutateSession(st.sessions, id, (s) => ({ ...s, title: title.trim() || s.title }));
			persist(sessions);
			return { sessions };
		});
	},

	deleteSession: (id) => {
		set((st) => {
			let sessions = st.sessions.filter((s) => s.id !== id);
			if (sessions.length === 0) sessions = [blankSession()];
			persist(sessions);
			return { sessions };
		});
	},

	setSessionModel: (id, model) => {
		set((st) => {
			const sessions = mutateSession(st.sessions, id, (s) => ({ ...s, model }));
			persist(sessions);
			return { sessions };
		});
	},

	addMessage: (sessionId, msg) => {
		set((st) => {
			const sessions = mutateSession(st.sessions, sessionId, (s) => {
				const withMsg = { ...s, messages: [...s.messages, msg], updatedAt: Date.now() };
				return { ...withMsg, title: autoTitle(withMsg) };
			});
			persist(sessions);
			return { sessions };
		});
	},

	appendToLast: (sessionId, full) => {
		// 流式中频繁写盘代价大，这里只更新内存；finishLast 时落盘
		set((st) => ({
			sessions: mutateSession(st.sessions, sessionId, (s) => {
				const msgs = [...s.messages];
				const last = msgs[msgs.length - 1];
				if (last && last.role === "assistant") msgs[msgs.length - 1] = { ...last, content: full };
				return { ...s, messages: msgs };
			}),
		}));
	},

	finishLast: (sessionId, full, error) => {
		set((st) => {
			const sessions = mutateSession(st.sessions, sessionId, (s) => {
				const msgs = [...s.messages];
				const last = msgs[msgs.length - 1];
				if (last && last.role === "assistant") msgs[msgs.length - 1] = { ...last, content: full, error: !!error };
				return { ...s, messages: msgs, updatedAt: Date.now() };
			});
			persist(sessions);
			return { sessions };
		});
	},

	dropLastAssistant: (sessionId) => {
		set((st) => {
			const sessions = mutateSession(st.sessions, sessionId, (s) => {
				const msgs = [...s.messages];
				if (msgs.length && msgs[msgs.length - 1].role === "assistant") msgs.pop();
				return { ...s, messages: msgs };
			});
			persist(sessions);
			return { sessions };
		});
	},

	popLastExchange: (sessionId) => {
		const sess = get().sessions.find((s) => s.id === sessionId);
		if (!sess || sess.messages.length === 0) return null;
		const msgs = [...sess.messages];
		if (msgs[msgs.length - 1].role === "assistant") msgs.pop();
		let restored: { text: string; images?: JyImage[]; files?: JyFile[] } | null = null;
		if (msgs.length && msgs[msgs.length - 1].role === "user") {
			const u = msgs.pop()!;
			restored = { text: u.content, images: u.images, files: u.files };
		}
		set((st) => {
			const sessions = mutateSession(st.sessions, sessionId, (s) => ({ ...s, messages: msgs }));
			persist(sessions);
			return { sessions };
		});
		return restored;
	},

	clearSession: (sessionId) => {
		set((st) => {
			const sessions = mutateSession(st.sessions, sessionId, (s) => ({ ...s, messages: [], title: "新对话" }));
			persist(sessions);
			return { sessions };
		});
	},

	setStreaming: (sessionId, v) => {
		set((st) => {
			const has = st.streamingIds.includes(sessionId);
			if (v && !has) return { streamingIds: [...st.streamingIds, sessionId] };
			if (!v && has) return { streamingIds: st.streamingIds.filter((x) => x !== sessionId) };
			return {};
		});
	},
}));

/* ─────────────────────────────────────────────────────────────────
 * 伪打字机：管理端文本是每 ~5s 一跳的流式结果（partialText=已累积全文），
 * 这里把"目标全文"逐字揭示到末条助手消息，速度随待显文本长度自适应
 * （越多越快，约每帧揭示剩余的 1/8），让 5s 一大段变成顺滑打字。
 * 由 store 单例驱动（模块级定时器），窗口关闭/分身切换都不打断、可被同会话的多窗口共享。
 * ───────────────────────────────────────────────────────────────── */
interface Typer {
	target: string;
	done: boolean;
	timer: ReturnType<typeof setInterval> | null;
}
const typers = new Map<string, Typer>();
const TYPE_TICK_MS = 24;

function shownLen(sid: string): number {
	const msgs = useJianyiStore.getState().getSession(sid)?.messages ?? [];
	const last = msgs[msgs.length - 1];
	return last && last.role === "assistant" ? last.content.length : 0;
}

function finalizeTyper(sid: string, t: Typer) {
	if (t.timer) clearInterval(t.timer);
	typers.delete(sid);
	useJianyiStore.getState().finishLast(sid, t.target, false);
	useJianyiStore.getState().setStreaming(sid, false);
}

function startTyperLoop(sid: string) {
	const t = typers.get(sid);
	if (!t || t.timer) return;
	t.timer = setInterval(() => {
		const cur = typers.get(sid);
		if (!cur) return;
		const shown = shownLen(sid);
		const pending = cur.target.length - shown;
		if (pending <= 0) {
			if (cur.done) finalizeTyper(sid, cur);
			else if (cur.timer) {
				clearInterval(cur.timer); // 追平上游、尚未结束 → 暂停，等下一段 feed
				cur.timer = null;
			}
			return;
		}
		const step = Math.max(1, Math.ceil(pending / 8)); // 速度随剩余长度自适应
		useJianyiStore.getState().appendToLast(sid, cur.target.slice(0, shown + step));
	}, TYPE_TICK_MS);
}

/** 收到一段流式累积全文（onProgress.partialText）：更新目标并确保打字机在跑 */
export function feedStream(sid: string, target: string) {
	let t = typers.get(sid);
	if (!t) {
		t = { target, done: false, timer: null };
		typers.set(sid, t);
	} else {
		t.target = target;
	}
	useJianyiStore.getState().setStreaming(sid, true);
	if (!t.timer && t.target.length > shownLen(sid)) startTyperLoop(sid);
}

/** 生成结束：success→把最终全文打完再落盘；error→立刻显示错误（不走打字机） */
export function endStream(sid: string, finalText: string, error?: boolean) {
	if (error) {
		const t = typers.get(sid);
		if (t?.timer) clearInterval(t.timer);
		typers.delete(sid);
		useJianyiStore.getState().finishLast(sid, finalText, true);
		useJianyiStore.getState().setStreaming(sid, false);
		return;
	}
	let t = typers.get(sid);
	if (!t) {
		t = { target: finalText, done: true, timer: null };
		typers.set(sid, t);
	} else {
		t.target = finalText;
		t.done = true;
	}
	if (shownLen(sid) >= t.target.length) finalizeTyper(sid, t);
	else startTyperLoop(sid);
}
