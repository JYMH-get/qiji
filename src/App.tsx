import { useEffect, useRef, useState } from "react";
import { useProjectStore } from "@/store/projectStore";
import { useSettingsStore } from "@/store/settingsStore";
import { useCanvasStore } from "@/store/canvasStore";
import { useUiStore } from "@/store/uiStore";
import { dispatchCommand } from "@/command/dispatch";
import { registerCanvasHandlers } from "@/command/registerCanvasHandlers";
import { SettingsModal } from "@/canvas/SettingsModal";
import { BlackboxPanel } from "@/canvas/BlackboxPanel";
import { RouterView } from "@/router/index";
import { TitleBar } from "@/canvas/TitleBar";
import { BrowserRouter as Router } from "react-router";

import { startPluginWatcher, stopPluginWatcher } from "@/nodes/pluginWatcher";
import { useCatalogStore } from "@/store/catalogStore";
import { useConnectionStore } from "@/store/connectionStore";
import { managedClient } from "@/services/managedClient";
import { LoginPage } from "@/canvas/LoginPage";
import "@/services/modelAdapter"; // 注册内置 mock 适配器（副作用）

// 应用启动时把命令处理器接到画布 store（同源指令核心落地）。
registerCanvasHandlers();

export default function App() {
	const loggedIn = useConnectionStore((s) => s.loggedIn);
	const [checking, setChecking] = useState(true);
	const initedRef = useRef(false);

	const initApp = async () => {
		// 0. 初始化全局配置及用户偏好设置，并恢复上次打开的项目 (Tauri 环境下由 settings.json 恢复)
		await useSettingsStore.getState().init();

		// Sync initial theme
		const initialTheme = useSettingsStore.getState().theme;
		if (initialTheme === "dark") {
			document.body.classList.add("dark");
		} else {
			document.body.classList.remove("dark");
		}

		// 从管理端拉取 catalog（模型/模板/出图模板/变体前缀），并据此注册 ManagedAdapter。
		// 启动先用本地缓存秒开，后台增量同步；未配置服务器时静默跳过（仅本地 mock 可用）。
		if (useConnectionStore.getState().isConfigured()) {
			useCatalogStore.getState().syncCatalog();
		}
		// 管理端连接配置变更后，自动重新拉取 catalog
		const unsubConnection = useConnectionStore.subscribe(
			(s, prev) => {
				if ((s.serverUrl !== prev.serverUrl || s.accessKey !== prev.accessKey) && s.isConfigured()) {
					useCatalogStore.getState().syncCatalog();
				}
			},
		);

		// Subscribe to settings theme changes globally
		const unsubTheme = useSettingsStore.subscribe(
			(s) => {
				if (s.theme === "dark") {
					document.body.classList.add("dark");
				} else {
					document.body.classList.remove("dark");
				}
			}
		);

		const isTauri = typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
		let loaded = false;
		if (isTauri) {
			const lastPath = useSettingsStore.getState().lastOpenedProjectPath;
			if (lastPath) {
				try {
					loaded = await useProjectStore.getState().loadFromPath(lastPath);
				} catch (e) {
					console.error("Failed to auto-load last project:", e);
				}
			}
		}

		// Set global flag to auto-redirect to editor if a project loaded on startup
		if (loaded) {
			(window as any).__loaded_on_startup = true;
		}

		// 如果未成功恢复历史项目且画布为空，则初始化播下三个示例节点
		if (!loaded && Object.keys(useCanvasStore.getState().nodes).length === 0) {
			const { makeNode } = await import("@/canvas/nodeFactory");
			dispatchCommand({ type: "addNode", node: makeNode("text", 80, 80) });
			dispatchCommand({ type: "addNode", node: makeNode("script", 80, 340) });
			dispatchCommand({ type: "addNode", node: makeNode("image", 420, 200) });
		}

		// 3. 启动插件热加载监控（仅 Tauri 环境生效）
		if (isTauri) {
			try {
				const { appDataDir, join } = await import("@tauri-apps/api/path");
				const { exists, mkdir } = await import("@tauri-apps/plugin-fs");
				const base = await appDataDir();
				const pluginsDir = await join(base, "plugins");
				if (!(await exists(pluginsDir))) {
					await mkdir(pluginsDir, { recursive: true });
				}
				startPluginWatcher(pluginsDir);
			} catch (e) {
				console.warn("[App] Plugin watcher setup skipped:", e);
			}
		}

		// 返回清理函数供 useEffect 调用
		return () => {
			unsubConnection();
			unsubTheme();
		};
	};

	// 启动：注册快捷键 + 校验登录态（心跳）。未登录显示登录页。
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.ctrlKey) {
				const key = e.key.toLowerCase();
				if (key === "s") {
					e.preventDefault();
					useProjectStore.getState().save();
				} else if (key === "o") {
					e.preventDefault();
					useProjectStore.getState().open();
				} else if (key === "n") {
					e.preventDefault();
					useProjectStore.getState().newProject();
				}
			}
		};
		window.addEventListener("keydown", handleKeyDown);

		(async () => {
			const conn = useConnectionStore.getState();
			if (conn.isConfigured()) {
				const r = await managedClient.heartbeat();
				conn.setSession(r.ok, r.user ?? null);
			}
			setChecking(false);
		})();

		return () => {
			window.removeEventListener("keydown", handleKeyDown);
			stopPluginWatcher();
		};
	}, []);

	// 登录后：初始化应用（仅一次）+ 周期心跳；掉线/被禁用则登出回登录页。
	useEffect(() => {
		if (!loggedIn) return;
		if (!initedRef.current) {
			initedRef.current = true;
			initApp();
		}
		const hb = setInterval(async () => {
			const r = await managedClient.heartbeat();
			if (!r.ok) useConnectionStore.getState().setSession(false, null);
		}, 30000);
		return () => clearInterval(hb);
	}, [loggedIn]);

	// ──── Debounced auto-save: canvas 变化 → 标记 dirty → debounce 3s → save ────
	const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		const unsubscribe = useCanvasStore.subscribe(() => {
			const { isProjectLoading, savePath } = useProjectStore.getState();
			// 仅在有已保存路径且不在加载阶段时触发自动保存
			if (isProjectLoading || !savePath) return;

			useProjectStore.getState().markDirty();

			if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
			autoSaveTimer.current = setTimeout(() => {
				useProjectStore.getState().save();
			}, 3000);
		});

		return () => {
			unsubscribe();
			if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
		};
	}, []);

	const settingsOpen = useUiStore((s) => s.settingsOpen);
	const blackboxOpen = useUiStore((s) => s.blackboxOpen);

	if (checking) {
		return (
			<div className="fixed inset-0 flex items-center justify-center bg-[#0a0b0f] text-white">
				<div className="flex flex-col items-center gap-3">
					<div className="w-8 h-8 border-4 border-[#5b8df6] border-t-transparent rounded-full animate-spin" />
					<p className="text-sm text-gray-400">正在连接管理端…</p>
				</div>
			</div>
		);
	}

	if (!loggedIn) {
		return <LoginPage onLoggedIn={() => { /* setSession 已在登录页触发，loggedIn 翻转即进入应用 */ }} />;
	}

	return (
		<Router>
			<div className="Qiji-shell">
				<TitleBar />
				<RouterView />
				{settingsOpen && <SettingsModal />}
				{blackboxOpen && <BlackboxPanel />}
			</div>
		</Router>
	);
}