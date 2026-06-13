import { useEffect } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { Canvas } from "@/canvas/Canvas";
import { FloatingToolbar } from "@/canvas/FloatingToolbar";
import { AssetPanel } from "@/canvas/AssetPanel";
import { ContextMenu } from "@/canvas/ContextMenu";
import { StatusBar } from "@/canvas/StatusBar";
import { TitleBar } from "@/canvas/TitleBar";
import { useProjectStore } from "@/store/projectStore";
import { useSettingsStore } from "@/store/settingsStore";
import { useCanvasStore } from "@/store/canvasStore";
import { useUiStore } from "@/store/uiStore";
import { dispatchCommand } from "@/command/dispatch";
import { registerCanvasHandlers } from "@/command/registerCanvasHandlers";
import { SettingsModal } from "@/canvas/SettingsModal";

import { LoginPage } from "@/canvas/LoginPage";
import { DashboardPage } from "@/canvas/DashboardPage";

// 应用启动时把命令处理器接到画布 store（同源指令核心落地）。
registerCanvasHandlers();

/**
 * 应用外壳：无限画布为底，四周浮层（左工具 dock / 顶素材 / 右键菜单 /
 * 底状态栏），选中节点后底部上下文操作面板浮现。
 */
export default function App() {
	useEffect(() => {
		// 0. 初始化全局配置及用户偏好设置，并恢复上次打开的项目 (Tauri 环境下由 settings.json 恢复)
		const initApp = async () => {
			await useSettingsStore.getState().init();
			
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

			// 如果未成功恢复历史项目且画布为空，则初始化播下三个示例节点
			if (!loaded && Object.keys(useCanvasStore.getState().nodes).length === 0) {
				const { makeNode } = await import("@/canvas/nodeFactory");
				dispatchCommand({ type: "addNode", node: makeNode("text", 80, 80) });
				dispatchCommand({ type: "addNode", node: makeNode("script", 80, 340) });
				dispatchCommand({ type: "addNode", node: makeNode("image", 420, 200) });
			}
		};
		initApp();

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
		};
	}, []);

	const settingsOpen = useUiStore((s) => s.settingsOpen);
	const currentScreen = useUiStore((s) => s.currentScreen);

	return (
		<div className="Qiji-shell">
			<TitleBar />
			{currentScreen === "login" && <LoginPage />}
			{currentScreen === "dashboard" && <DashboardPage />}
			{currentScreen === "canvas" && (
				<ReactFlowProvider>
					<div className="Qiji-canvas">
						<Canvas />
						<FloatingToolbar />
						<AssetPanel />
						<StatusBar />
						<ContextMenu />
					</div>
				</ReactFlowProvider>
			)}
			{settingsOpen && <SettingsModal />}
		</div>
	);
}

