import { useEffect, useRef, useState } from "react";
import { useProjectStore } from "@/store/projectStore";
import { useSettingsStore } from "@/store/settingsStore";
import { useCanvasStore } from "@/store/canvasStore";
import { useUiStore } from "@/store/uiStore";
import { dispatchCommand } from "@/command/dispatch";
import { registerCanvasHandlers } from "@/command/registerCanvasHandlers";
import { SettingsModal } from "@/canvas/SettingsModal";
import { ProjectSettingsModal } from "@/components/ProjectSettingsModal";
import { BlackboxPanel } from "@/canvas/BlackboxPanel";
import { RouterView } from "@/router/index";
import { TitleBar } from "@/canvas/TitleBar";
import { BrowserRouter as Router } from "react-router";

import { verifyActivation } from "@/services/auth";
import { ActivationOverlay } from "@/canvas/ActivationOverlay";
import { startPluginWatcher, stopPluginWatcher } from "@/nodes/pluginWatcher";
import { syncChannelAdapters } from "@/services/adapters/channelAdapter";

// 应用启动时把命令处理器接到画布 store（同源指令核心落地）。
registerCanvasHandlers();

export default function App() {
	const [isActivated, setIsActivated] = useState(false);
	const [checkingActivation, setCheckingActivation] = useState(true);

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

		// 根据渠道配置同步注册模型 adapters（使设置中的渠道模型可在面板中选择）
		syncChannelAdapters();
		// 监听 channels 变更，自动重新注册 adapters
		const unsubChannels = useSettingsStore.subscribe(
			(s, prev) => {
				if (s.channels !== prev.channels) {
					syncChannelAdapters();
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
			unsubChannels();
			unsubTheme();
		};
	};

	useEffect(() => {
		let cleanup: (() => void) | undefined;
		const checkActivationAndInit = async () => {
			const activated = await verifyActivation();
			setIsActivated(activated);
			setCheckingActivation(false);
 
			if (activated) {
				cleanup = await initApp();
			}
		};
		checkActivationAndInit();

		// 2. 注册快捷键 Ctrl+S / Ctrl+O / Ctrl+N
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
		return () => {
			window.removeEventListener("keydown", handleKeyDown);
			stopPluginWatcher();
			cleanup?.();
		};
	}, []);

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
	const projectSettingsOpen = useUiStore((s) => s.projectSettingsOpen);
	const blackboxOpen = useUiStore((s) => s.blackboxOpen);

	if (checkingActivation) {
		return (
			<div className="fixed inset-0 flex items-center justify-center bg-[#0a0b0f] text-white">
				<div className="text-center flex flex-col items-center gap-3">
					<div className="w-8 h-8 border-4 border-[#5b8df6] border-t-transparent rounded-full animate-spin"></div>
					<p className="text-sm text-gray-400">正在检查授权状态...</p>
				</div>
			</div>
		);
	}

	if (!isActivated) {
		return <ActivationOverlay onActivated={() => {
			setIsActivated(true);
			initApp();
		}} />;
	}

	return (
		<Router>
			<div className="Qiji-shell">
				<TitleBar />
				<RouterView />
				{settingsOpen && <SettingsModal />}
				{projectSettingsOpen && <ProjectSettingsModal />}
				{blackboxOpen && <BlackboxPanel />}
			</div>
		</Router>
	);
}