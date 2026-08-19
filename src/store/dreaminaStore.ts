/**
 * dreaminaStore —— 即梦（Dreamina）授权状态（会话态，不落盘；真凭据在用户全局 ~/.dreamina_cli）。
 *
 * 刷新时机：App 启动（features.dreamina 开时）+ 个人中心打开授权区块 + 登录/登出动作后。
 * `authed` 是模型下拉显示「即梦 · Seedance 2.0」的前提之一（另一个是 features.dreamina）。
 *
 * 登录 = OAuth 设备码流：`login --headless` 取材料 → 自动开浏览器授权页（展示 user_code）→
 * `login checklogin` 轮询收尾（整体 5 分钟超时）。用户在终端已登录过 CLI 时直接复用（免流程）。
 */
import { create } from "zustand";
import {
	dreaminaAccountInfo,
	dreaminaCheckLogin,
	dreaminaLoginHeadless,
	dreaminaLogout,
	openExternalUrl,
} from "@/services/dreaminaCli";

const LOGIN_TIMEOUT_MS = 5 * 60_000;

interface DreaminaState {
	/** 已登录即梦（本机全局凭据有效） */
	authed: boolean;
	/** 即梦账号 user_id（authed 时有值） */
	userId: string;
	/** 即梦积分余额（`user_credit`，与 Qiji 积分无关） */
	totalCredit: number;
	/** 会员档位（如 maestro；空=普通） */
	vipLevel: string;
	/** 状态刷新中 */
	checking: boolean;
	/** 设备码登录进行中 */
	loggingIn: boolean;
	/** 登录等待授权时展示的配对码（用户需在浏览器页面核对/输入） */
	pendingUserCode: string;
	/** 授权页链接（自动打开失败时用户可手动复制） */
	pendingVerificationUri: string;
	/** 最近一次登录失败原因（展示用） */
	loginError: string;
	/** 是否已至少刷新过一次（区分「未查」与「查过=未登录」） */
	checked: boolean;

	/** 查询 `user_credit` 刷新状态 */
	refresh: () => Promise<void>;
	/** 设备码登录（阻塞至授权完成/超时），完成后自动刷新 */
	loginDeviceFlow: () => Promise<boolean>;
	/** 退出登录并刷新 */
	logout: () => Promise<void>;
}

export const useDreaminaStore = create<DreaminaState>((set, get) => ({
	authed: false,
	userId: "",
	totalCredit: 0,
	vipLevel: "",
	checking: false,
	loggingIn: false,
	pendingUserCode: "",
	pendingVerificationUri: "",
	loginError: "",
	checked: false,

	refresh: async () => {
		if (get().checking) return;
		set({ checking: true });
		const info = await dreaminaAccountInfo();
		set({
			checking: false,
			checked: true,
			authed: !!info,
			userId: info?.userId ?? "",
			totalCredit: info?.totalCredit ?? 0,
			vipLevel: info?.vipLevel ?? "",
		});
	},

	loginDeviceFlow: async () => {
		if (get().loggingIn) return false;
		set({ loggingIn: true, loginError: "", pendingUserCode: "", pendingVerificationUri: "" });
		try {
			const r = await dreaminaLoginHeadless();
			if (r.authed) return true; // 本地凭据仍有效，直接复用
			set({ pendingUserCode: r.device.userCode, pendingVerificationUri: r.device.verificationUri });
			await openExternalUrl(r.device.verificationUri).catch(() => undefined); // 打不开就靠 UI 展示的链接
			const deadline = Date.now() + LOGIN_TIMEOUT_MS;
			while (Date.now() < deadline) {
				if (await dreaminaCheckLogin(r.device.deviceCode, 30)) return true;
			}
			set({ loginError: "登录超时（5 分钟内未完成浏览器授权），请重试" });
			return false;
		} catch (e) {
			set({ loginError: e instanceof Error ? e.message : "登录失败" });
			return false;
		} finally {
			set({ loggingIn: false, pendingUserCode: "", pendingVerificationUri: "" });
			await get().refresh();
		}
	},

	logout: async () => {
		await dreaminaLogout();
		set({ authed: false, userId: "", totalCredit: 0, vipLevel: "" });
		await get().refresh();
	},
}));

/** 非 hook：当前是否已授权即梦（adapter 提交前预检用） */
export function isDreaminaAuthed(): boolean {
	return useDreaminaStore.getState().authed;
}
