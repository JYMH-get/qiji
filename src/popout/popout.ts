/**
 * popout —— 把悬浮助手「弹出」为独立的 Tauri 窗口（可拖到主窗口外 / 第二屏）。
 *
 * 机制（折中方案）：弹出窗口 = 同一应用的第二个 Tauri 窗口，URL 带 `?popout=<which>`，
 * 复用 App 的启动流程（连接 / catalog / 自动加载上次项目），只渲染对应助手（见 PopoutView）。
 * 弹出窗口对项目文件**只读**（projectStore.save 在 popout 中跳过，避免与主窗口互相覆盖）；
 * 会话 / 任务等经 localStorage 与主窗口同源共享。
 */

export type PopoutWhich = "jianyi" | "asset";

const WHICHES: PopoutWhich[] = ["jianyi", "asset"];

const TITLES: Record<PopoutWhich, string> = {
	jianyi: "简一助手",
	asset: "资产助手",
};

const SIZES: Record<PopoutWhich, { w: number; h: number }> = {
	jianyi: { w: 420, h: 720 },
	asset: { w: 460, h: 780 },
};

function isTauri(): boolean {
	return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

/** 当前窗口是否为某个助手的弹出窗口；是则返回 which，否则 null。 */
export function getPopoutWhich(): PopoutWhich | null {
	if (typeof window === "undefined") return null;
	const w = new URLSearchParams(window.location.search).get("popout");
	return w && (WHICHES as string[]).includes(w) ? (w as PopoutWhich) : null;
}

export function isPopout(): boolean {
	return getPopoutWhich() !== null;
}

/**
 * 打开（或聚焦）某个助手的独立窗口。
 * Tauri：新建 / 聚焦 `popout-<which>` WebviewWindow；浏览器（dev 无 Tauri）：退回新标签页。
 */
export async function openPopout(which: PopoutWhich): Promise<void> {
	const url = `${window.location.pathname}?popout=${which}`;
	if (!isTauri()) {
		window.open(url, "_blank", "noopener");
		return;
	}
	try {
		const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
		const label = `popout-${which}`;
		const existing = await WebviewWindow.getByLabel(label);
		if (existing) {
			await existing.setFocus();
			return;
		}
		const { w, h } = SIZES[which];
		const win = new WebviewWindow(label, {
			url,
			title: `Qiji · ${TITLES[which]}`,
			width: w,
			height: h,
			minWidth: 320,
			minHeight: 360,
			resizable: true,
			decorations: true,
			dragDropEnabled: false, // 与主窗口一致：不拦截网页内 HTML5 拖拽
		});
		win.once("tauri://error", (e) => console.error("[popout] 创建窗口失败", which, e));
	} catch (err) {
		console.error("[popout] openPopout 失败，退回新标签页", err);
		window.open(url, "_blank", "noopener");
	}
}
