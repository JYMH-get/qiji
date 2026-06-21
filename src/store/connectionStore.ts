import { create } from "zustand";

/**
 * connectionStore —— 用户端与管理端的连接配置（唯一对外凭证）。
 *
 * 用户端不持有任何第三方 key，只需要：
 *   - serverUrl：管理端地址（如 https://gw.yourcompany.com）
 *   - accessKey：管理端签发的用户级令牌
 *
 * 持久化：本阶段用 localStorage（浏览器/Tauri WebView 均可用）。
 * 后续如需与 settings.json 统一，再迁移即可（接口不变）。
 */

const LS_KEY = "Qiji:connection";

interface Persisted {
	serverUrl: string;
	accessKey: string;
}

function load(): Persisted {
	try {
		const raw = localStorage.getItem(LS_KEY);
		if (raw) return JSON.parse(raw);
	} catch {
		/* ignore */
	}
	return { serverUrl: "", accessKey: "" };
}

function persist(p: Persisted): void {
	try {
		localStorage.setItem(LS_KEY, JSON.stringify(p));
	} catch {
		/* ignore */
	}
}

interface SessionUser {
	id: string;
	name: string;
	credits: number;
}

interface ConnectionState extends Persisted {
	/** 最近一次连通性测试结果 */
	online: boolean;
	lastError: string | null;
	/** 登录态：未登录不可用 */
	loggedIn: boolean;
	user: SessionUser | null;
	setServerUrl: (url: string) => void;
	setAccessKey: (key: string) => void;
	/** 去掉末尾斜杠的规范化地址 */
	normalizedUrl: () => string;
	/** 是否已配置完整 */
	isConfigured: () => boolean;
	setOnline: (online: boolean, error?: string | null) => void;
	setSession: (loggedIn: boolean, user?: SessionUser | null) => void;
}

export const useConnectionStore = create<ConnectionState>((set, get) => ({
	...load(),
	online: false,
	lastError: null,
	loggedIn: false,
	user: null,

	setServerUrl: (serverUrl) => {
		set({ serverUrl });
		persist({ serverUrl, accessKey: get().accessKey });
	},
	setAccessKey: (accessKey) => {
		set({ accessKey });
		persist({ serverUrl: get().serverUrl, accessKey });
	},
	normalizedUrl: () => get().serverUrl.replace(/\/+$/, ""),
	isConfigured: () => !!get().serverUrl && !!get().accessKey,
	setOnline: (online, error = null) => set({ online, lastError: error }),
	setSession: (loggedIn, user = null) => set({ loggedIn, user }),
}));
