/**
 * libtvStore —— LibTV 授权状态（会话态，不落盘；真凭据在 Rust 侧 LIBTV_CONFIG_DIR）。
 *
 * 刷新时机：App 启动（features.libtv 开时）+ 个人中心打开授权区块 + 登录/登出动作后。
 * `authed` 是模型下拉显示「LibTV · Seedance 2.0」的前提之一（另一个是 features.libtv）。
 */
import { create } from "zustand";
import { libtvAccountInfo, libtvLoginWeb, libtvLogout } from "@/services/libtvCli";

interface LibtvState {
	/** 已登录 LibTV（本机凭据有效） */
	authed: boolean;
	/** 登录用户昵称（authed 时有值） */
	nickname: string;
	/** 当前生效账户名（团队场景；可空） */
	accountName: string;
	/** 会员套餐名（如「标准版VIP 连续包月」；CLI 不提供积分接口，会员信息是当前可得的账户权益展示） */
	memberName: string;
	/** 状态刷新中 */
	checking: boolean;
	/** 浏览器登录等待回跳中 */
	loggingIn: boolean;
	/** 最近一次登录失败原因（展示用） */
	loginError: string;
	/** 是否已至少刷新过一次（区分「未查」与「查过=未登录」） */
	checked: boolean;

	/** 查询 `libtv account info` 刷新状态 */
	refresh: () => Promise<void>;
	/** 浏览器登录（阻塞至回跳/超时），完成后自动刷新 */
	loginWeb: () => Promise<boolean>;
	/** 退出登录并刷新 */
	logout: () => Promise<void>;
}

export const useLibtvStore = create<LibtvState>((set, get) => ({
	authed: false,
	nickname: "",
	accountName: "",
	memberName: "",
	checking: false,
	loggingIn: false,
	loginError: "",
	checked: false,

	refresh: async () => {
		if (get().checking) return;
		set({ checking: true });
		const info = await libtvAccountInfo();
		set({
			checking: false,
			checked: true,
			authed: !!info,
			nickname: info?.nickname ?? "",
			accountName: info?.accountName ?? "",
			memberName: info?.memberName ?? "",
		});
	},

	loginWeb: async () => {
		if (get().loggingIn) return false;
		set({ loggingIn: true, loginError: "" });
		try {
			const r = await libtvLoginWeb();
			if (!r.ok) set({ loginError: r.error || "登录未完成" });
			return r.ok;
		} catch (e) {
			set({ loginError: e instanceof Error ? e.message : "登录失败" });
			return false;
		} finally {
			set({ loggingIn: false });
			await get().refresh();
		}
	},

	logout: async () => {
		await libtvLogout();
		set({ authed: false, nickname: "", accountName: "", memberName: "" });
		await get().refresh();
	},
}));

/** 非 hook：当前是否已授权 LibTV（adapter 提交前预检用） */
export function isLibtvAuthed(): boolean {
	return useLibtvStore.getState().authed;
}
