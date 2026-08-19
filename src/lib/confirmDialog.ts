/**
 * confirmDialog —— 应用内确认弹窗（第121轮，两次定稿）。
 *
 * ⚠ 历史（勿回退）：
 * - v1 用 window.confirm：Tauri（wry/WebView2）下不弹窗直接放行，覆盖/删除确认在真机形同虚设；
 * - v2 用 plugin-dialog 原生 ask：能弹但是系统默认 UI，与软件深色风格不搭（用户否决）；
 * - v3（现行）：**应用内 React 弹窗**（ConfirmModal，App 挂载，深色同风格）——store 驱动 +
 *   Promise 桥接，所有环境（Tauri/浏览器 dev）统一走它。
 *
 * 用法：`if (!(await confirmDialog("确定删除？"))) return;`
 * 覆盖/删除类确认一律用本函数，勿再用 window.confirm / plugin-dialog ask。
 */
import { create } from "zustand";

interface ConfirmState {
	open: boolean;
	message: string;
	title: string;
	/** 未决 Promise 的 resolve（settleConfirm 调用；null=无弹窗） */
	resolve: ((ok: boolean) => void) | null;
}

export const useConfirmStore = create<ConfirmState>(() => ({
	open: false,
	message: "",
	title: "",
	resolve: null,
}));

/** 弹出确认框，resolve(true)=确定 / resolve(false)=取消。同时只允许一个：新弹窗顶掉旧的（旧的按取消结算）。 */
export function confirmDialog(message: string, title = "操作确认"): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		const prev = useConfirmStore.getState().resolve;
		prev?.(false);
		useConfirmStore.setState({ open: true, message, title, resolve });
	});
}

/** 结算当前弹窗（ConfirmModal 的按钮/Esc/遮罩调用） */
export function settleConfirm(ok: boolean) {
	const r = useConfirmStore.getState().resolve;
	useConfirmStore.setState({ open: false, message: "", title: "", resolve: null });
	r?.(ok);
}
