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

/** 默认服务器地址（第225轮：登录页隐藏服务器地址栏，普通用户零配置直连）。
 *  dev 走本机 8787 不误连生产；打包版默认新服务器。⚠ 换服务器/上域名时只改这一处。 */
export const DEFAULT_SERVER_URL = import.meta.env.DEV ? "http://localhost:8787" : "http://103.120.91.71:8787";

interface Persisted {
	serverUrl: string;
	accessKey: string;
	/** 最近登录/注册使用的账号（仅用于展示与登录页预填；真凭证仍是 accessKey） */
	account: string;
}

function load(): Persisted {
	try {
		const raw = localStorage.getItem(LS_KEY);
		if (raw) {
			const p = { account: "", ...JSON.parse(raw) } as Persisted;
			// 第226轮用户定稿：**完全使用新服务器，不保留旧服务器记录**——启动一律钉回默认地址
			// （老安装升级后本地存的旧服务器/旧域名地址直接作废；账号与凭证保留，登录不受影响）。
			// 双击 logo 改的地址只在本次运行期有效，重启即回默认——将来要支持渠道商节点常驻自定义
			// 地址时再放开这里。
			p.serverUrl = DEFAULT_SERVER_URL;
			return p;
		}
	} catch {
		/* ignore */
	}
	return { serverUrl: DEFAULT_SERVER_URL, accessKey: "", account: "" };
}

function persist(p: Persisted): void {
	try {
		localStorage.setItem(LS_KEY, JSON.stringify(p));
	} catch {
		/* ignore */
	}
}

/**
 * 本机设备标识（第218轮：机器码/硬件指纹整体退役——身份验证一律凭 API 密钥（accessKey），
 * 设备 id 只用于「同时在线设备限制」的设备区分，无任何身份语义、不采集任何硬件信息）。
 * 首启随机 UUID 持久化 localStorage；清应用数据=新设备（占一个在线名额，属预期）。
 * ⚠ 升级续用：优先读旧机器码键（Qiji:hwCode/Qiji:machineCode）作为设备 id——
 * 老用户升级后设备身份不变，不会被自己的旧设备记录抢占登出（勿删这条回退链）。
 */
const DEVICE_KEY = "Qiji:deviceId";
let deviceId: string | null = null;

/** 获取本机设备标识（同步、无 IO 等待——随每个请求的 x-device-id 头发出） */
export function getDeviceId(): string {
	if (deviceId) return deviceId;
	try {
		const id = localStorage.getItem(DEVICE_KEY)
			?? localStorage.getItem("Qiji:hwCode")
			?? localStorage.getItem("Qiji:machineCode")
			?? ((typeof crypto !== "undefined" && crypto.randomUUID)
				? crypto.randomUUID()
				: `dev-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		localStorage.setItem(DEVICE_KEY, id);
		deviceId = id;
		return id;
	} catch {
		return "dev-unknown";
	}
}

interface SessionUser {
	id: string;
	name: string;
	credits: number;
	/** 功能开关（服务端按用户下发；字段缺省=开）：控制可用模式，见 useModeFeatures；libtv/dreamina 见对应 hook；
	 *  modes=动态视频模式门禁（第130轮，modeId→bool，缺省=开）：关=模型下拉隐藏该模式（服务端 403 亦拦） */
	features?: { assetMode?: boolean; canvasMode?: boolean; editorMode?: boolean; libtv?: boolean; dreamina?: boolean; comfyui?: boolean; modes?: Record<string, boolean> };
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
	setAccount: (account: string) => void;
	/** 去掉末尾斜杠的规范化地址 */
	normalizedUrl: () => string;
	/** 是否已配置完整 */
	isConfigured: () => boolean;
	setOnline: (online: boolean, error?: string | null) => void;
	setSession: (loggedIn: boolean, user?: SessionUser | null) => void;
	/** 更新当前用户余额（兑换/心跳后刷新，状态栏与个人中心即时反映） */
	setCredits: (credits: number) => void;
}

export const useConnectionStore = create<ConnectionState>((set, get) => ({
	...load(),
	online: false,
	lastError: null,
	loggedIn: false,
	user: null,

	setServerUrl: (serverUrl) => {
		set({ serverUrl });
		persist({ serverUrl, accessKey: get().accessKey, account: get().account });
	},
	setAccessKey: (accessKey) => {
		set({ accessKey });
		persist({ serverUrl: get().serverUrl, accessKey, account: get().account });
	},
	setAccount: (account) => {
		set({ account });
		persist({ serverUrl: get().serverUrl, accessKey: get().accessKey, account });
	},
	normalizedUrl: () => get().serverUrl.replace(/\/+$/, ""),
	isConfigured: () => !!get().serverUrl && !!get().accessKey,
	setOnline: (online, error = null) => set({ online, lastError: error }),
	setSession: (loggedIn, user = null) => set({ loggedIn, user }),
	setCredits: (credits) => set((s) => (s.user ? { user: { ...s.user, credits } } : {})),
}));

/** 模式开关（归一后）：字段缺省=开；三个全关视为配置错误，保底回退「仅资产模式」 */
export interface ModeFeatures {
	assetMode: boolean;
	canvasMode: boolean;
	editorMode: boolean;
}

function normalizeModeFeatures(asset: boolean, canvas: boolean, editor: boolean): ModeFeatures {
	return asset || canvas || editor
		? { assetMode: asset, canvasMode: canvas, editorMode: editor }
		: { assetMode: true, canvasMode: false, editorMode: false };
}

/** 非 hook：读当前用户的模式开关（登录/心跳下发；未登录=全开，登录页等场景不受限） */
export function getModeFeatures(): ModeFeatures {
	const f = useConnectionStore.getState().user?.features;
	return normalizeModeFeatures(f?.assetMode !== false, f?.canvasMode !== false, f?.editorMode !== false);
}

/** hook：订阅模式开关（管理端改开关 → 心跳刷新 user → 界面即时隐藏/恢复模式交互键） */
export function useModeFeatures(): ModeFeatures {
	const asset = useConnectionStore((s) => s.user?.features?.assetMode !== false);
	const canvas = useConnectionStore((s) => s.user?.features?.canvasMode !== false);
	const editor = useConnectionStore((s) => s.user?.features?.editorMode !== false);
	return normalizeModeFeatures(asset, canvas, editor);
}

/** 非 hook：LibTV 授权入口开关（缺省=开；管理端可按用户关闭，心跳 ≤30s 生效） */
export function getLibtvFeature(): boolean {
	return useConnectionStore.getState().user?.features?.libtv !== false;
}

/** hook：订阅 LibTV 入口开关（个人中心授权区块 / 视频模型下拉的显隐依据之一） */
export function useLibtvFeature(): boolean {
	return useConnectionStore((s) => s.user?.features?.libtv !== false);
}

/** 非 hook：即梦授权入口开关（缺省=开；管理端可按用户关闭，心跳 ≤30s 生效） */
export function getDreaminaFeature(): boolean {
	return useConnectionStore.getState().user?.features?.dreamina !== false;
}

/** hook：订阅即梦入口开关（个人中心授权区块 / 视频模型下拉的显隐依据之一） */
export function useDreaminaFeature(): boolean {
	return useConnectionStore((s) => s.user?.features?.dreamina !== false);
}

/** 非 hook：ComfyUI 直连入口开关（缺省=开；管理端可按用户关闭，心跳 ≤30s 生效） */
export function getComfyuiFeature(): boolean {
	return useConnectionStore.getState().user?.features?.comfyui !== false;
}

/** hook：订阅 ComfyUI 直连入口开关（个人中心绑定区块 / 视频模型下拉的显隐依据之一） */
export function useComfyuiFeature(): boolean {
	return useConnectionStore((s) => s.user?.features?.comfyui !== false);
}
