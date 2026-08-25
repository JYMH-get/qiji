import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useAnnotationStore } from "@/store/annotationStore";
import { useViewAngleStore } from "@/store/viewAngleStore";
import { usePanoStore } from "@/store/panoStore";
import { useDirectorStore } from "@/store/directorStore";
import { useProjectStore } from "@/store/projectStore";
import { useSettingsStore } from "@/store/settingsStore";
import { useCanvasStore } from "@/store/canvasStore";
import { useUiStore } from "@/store/uiStore";
import { dispatchCommand } from "@/command/dispatch";
import { registerCanvasHandlers } from "@/command/registerCanvasHandlers";
import { SettingsModal } from "@/canvas/SettingsModal";
import { PersonalCenter } from "@/components/PersonalCenter";
import { ToolboxModal } from "@/components/ToolboxModal";
import { useToolboxStore } from "@/store/toolboxStore";
import { RouterView } from "@/router/index";
import { TitleBar } from "@/canvas/TitleBar";
import { BrowserRouter as Router, useLocation, useNavigate } from "react-router";
import { useModeFeatures, type ModeFeatures } from "@/store/connectionStore";
import AssetAssistant from "@/components/AssetAssistant";
import JianyiAssistant from "@/components/JianyiAssistant";
import Lightbox from "@/components/Lightbox";
import PromptModal from "@/components/PromptModal";
import AssetCheckModal from "@/components/AssetCheckModal";
import SharedPickModal from "@/components/SharedPickModal";
import ConfirmModal from "@/components/ConfirmModal";
import { TaskRecoveryNotice } from "@/components/TaskRecoveryNotice";

/** 图片涂鸦编辑器：konva 体积不小，lazy 到首次唤起才加载（无会话时零成本） */
const AnnotationEditorLazy = lazy(() => import("@/components/AnnotationEditor"));
function AnnotationEditorHost() {
	const hasSession = useAnnotationStore((s) => !!s.session);
	if (!hasSession) return null;
	return (
		<Suspense fallback={null}>
			<AnnotationEditorLazy />
		</Suspense>
	);
}

/** 「转视角」多角度编辑器：轻量弹窗，有会话才渲染（lazy 与涂鸦同理，避免进主包路径膨胀） */
const ViewAngleModalLazy = lazy(() => import("@/components/ViewAngleModal"));
function ViewAngleModalHost() {
	const hasSession = useViewAngleStore((s) => !!s.session);
	if (!hasSession) return null;
	return (
		<Suspense fallback={null}>
			<ViewAngleModalLazy />
		</Suspense>
	);
}

/** 720°全景查看器：WebGL 组件 lazy，有会话才渲染（关闭即卸载并释放 WebGL context） */
const PanoViewerModalLazy = lazy(() => import("@/components/PanoViewerModal"));
function PanoViewerModalHost() {
	const hasSession = usePanoStore((s) => !!s.session);
	if (!hasSession) return null;
	return (
		<Suspense fallback={null}>
			<PanoViewerModalLazy />
		</Suspense>
	);
}

/** 3D 导演台：three 体积大（~600KB），lazy 到首次唤起才加载（关闭卸载并释放 WebGL context） */
const DirectorStageModalLazy = lazy(() => import("@/components/DirectorStageModal"));
function DirectorStageModalHost() {
	const hasSession = useDirectorStore((s) => !!s.session);
	if (!hasSession) return null;
	return (
		<Suspense fallback={null}>
			<DirectorStageModalLazy />
		</Suspense>
	);
}

/** 悬浮助手停靠组：资产助手 + 简一助手（竖直叠放、同步移动）。项目管理界面（/）也显示。 */
function FloatingAssistants() {
	return (
		<>
			<AssetAssistant />
			<JianyiAssistant />
		</>
	);
}

/**
 * 路由快照追踪：把「用户当前停留的页面」写进项目快照（uiSnapshot.route），
 * 重开软件/项目时由 Frame21 恢复到这一页。仅在项目已落盘且处于真实工作页时记录
 * （大厅 / 与新建向导 /frame164 不覆盖，避免离开项目时把"停留页"抹成大厅）。
 */
function RouteSnapshotTracker() {
	const { pathname } = useLocation();
	useEffect(() => {
		const { savePath, isProjectLoading } = useProjectStore.getState();
		if (isProjectLoading || !savePath) return;
		if (pathname === "/" || pathname === "/frame164") return;
		useProjectStore.getState().setUiSnapshot({ route: pathname });
	}, [pathname]);
	return null;
}

/**
 * 第245轮补充：浅色主题只覆盖 大厅（/）与 新建项目（/frame164）两页——项目内工作区
 * （剧本/资产/视频/画布/实时剪辑）的 UI 历轮全按深色设计开发，浅色主题下大面积白字贴白底不可读
 * （用户实报）。进入项目路由一律按深色渲染（body.dark），回到大厅/新建页还原用户所选主题。
 * ⚠ 本组件是 body.dark 的最终权威（App init/主题订阅/两处 toggleTheme 的直改会被本效果按
 * 「主题 × 路由」纠正）——项目内页面勿再做逐页浅色适配，浅色支持只在这两页与深色弹窗孤岛（styles.css）。
 */
const LIGHT_THEME_ROUTES = new Set(["/", "/frame164"]);
function ThemeBodySync() {
	const { pathname } = useLocation();
	const theme = useSettingsStore((s) => s.theme);
	useEffect(() => {
		const dark = theme === "dark" || !LIGHT_THEME_ROUTES.has(pathname);
		document.body.classList.toggle("dark", dark);
	}, [pathname, theme]);
	return null;
}

// 资产（表格）模式的全部路由（大厅 / 与新建 /frame164 不算模式页，两种开关下都可用）
const ASSET_MODE_ROUTES = new Set([
	"/frame1693", "/frame16285", "/frame-group", "/frame16550", "/frame16780", "/frame161000", "/frame161195",
]);

// 模式 → 所属路由集合 + 该模式默认落点；ModeGuard 按此表通用判定（新增模式只加一行）
const MODE_ROUTE_TABLE: { key: keyof ModeFeatures; routes: Set<string>; home: string }[] = [
	{ key: "assetMode", routes: ASSET_MODE_ROUTES, home: "/frame1693" },
	{ key: "canvasMode", routes: new Set(["/frame-canvas"]), home: "/frame-canvas" },
	{ key: "editorMode", routes: new Set(["/frame-editor"]), home: "/frame-editor" },
];

/**
 * 模式守卫：服务端按用户下发模式开关（登录/心跳），当前路由所属模式被关 → 重定向到
 * 第一个可用模式的默认路由——覆盖所有入口（快照路由恢复/历史导航/手输），交互键的隐藏在各界面另行处理。
 */
function ModeGuard() {
	const { pathname } = useLocation();
	const navigate = useNavigate();
	const { assetMode, canvasMode, editorMode } = useModeFeatures();
	useEffect(() => {
		const enabled: Record<keyof ModeFeatures, boolean> = { assetMode, canvasMode, editorMode };
		const current = MODE_ROUTE_TABLE.find((m) => m.routes.has(pathname));
		if (!current || enabled[current.key]) return;
		const fallback = MODE_ROUTE_TABLE.find((m) => enabled[m.key]);
		if (fallback) navigate(fallback.home, { replace: true });
	}, [pathname, assetMode, canvasMode, editorMode, navigate]);
	return null;
}

import { startPluginWatcher, stopPluginWatcher } from "@/nodes/pluginWatcher";
import { isPopout } from "@/popout/popout";
import { PopoutView } from "@/popout/PopoutView";
import { useCatalogStore } from "@/store/catalogStore";
import { useConnectionStore } from "@/store/connectionStore";
import { managedClient } from "@/services/managedClient";
import { LoginPage } from "@/canvas/LoginPage";
import "@/services/modelAdapter"; // 注册内置 mock 适配器（副作用）

// 应用启动时把命令处理器接到画布 store（同源指令核心落地）。
registerCanvasHandlers();

// 资产模式 → 画布投影改为**用户手动触发**（资产模式顶栏「同步到画布」按钮，见 EditorHeader），
// 不再自动订阅——避免自动投影悄悄覆盖用户在画布的进度。

export default function App() {
	const loggedIn = useConnectionStore((s) => s.loggedIn);
	const [checking, setChecking] = useState(true);
	const initedRef = useRef(false);
	// 掉线容差：连续瞬时心跳失败计数（网络抖动不立即登出，达到阈值才回登录页）
	const hbFailures = useRef(0);

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
			void useCatalogStore.getState().syncCatalog();
		}
		// LibTV 本地适配器：注册须在项目加载前（resumePendingGenerations 凭 adapterKey 找回在途任务）；
		// 授权状态后台静默探测（未内置 CLI/未登录 → 未授权，模型下拉不出现 LibTV 项）
		{
			const { registerLibtvAdapter } = await import("@/services/adapters/libtvAdapter");
			registerLibtvAdapter();
			void (await import("@/store/libtvStore")).useLibtvStore.getState().refresh();
		}
		// 即梦（Dreamina）本地适配器：同 LibTV——注册须在项目加载前，授权状态后台静默探测
		{
			const { registerDreaminaAdapter } = await import("@/services/adapters/dreaminaAdapter");
			registerDreaminaAdapter();
			void (await import("@/store/dreaminaStore")).useDreaminaStore.getState().refresh();
		}
		// ComfyUI 直连本地适配器：同上——注册须在项目加载前（绑定状态从 localStorage 同步读出，无需探测）
		{
			const { registerComfyuiAdapter } = await import("@/services/adapters/comfyuiAdapter");
			registerComfyuiAdapter();
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

		// 标记「启动时已自动恢复项目」——写进 store（响应式），Frame21 据此跳到上次停留的页面。
		// 不再用一次性 window 标志：loadFromPath 是异步慢路径，可能晚于 Frame21 的挂载 effect，
		// 用 store 字段让 Frame21 即便晚到也能响应（修复"重项目冷启动被困在大厅"）。
		if (loaded) {
			useProjectStore.setState({ loadedOnStartup: true });
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
					useProjectStore.getState().save(true);
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
			// 第218轮：机器码/硬件指纹退役——设备 id 是同步的 localStorage 随机 UUID，无需启动等待
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

	// 全局屏蔽浏览器右键菜单（桌面应用观感）；文本输入框保留（右键粘贴）
	useEffect(() => {
		const onContextMenu = (e: MouseEvent) => {
			const t = e.target as HTMLElement | null;
			if (t?.closest("input, textarea, [contenteditable=''], [contenteditable='true']")) return;
			e.preventDefault();
		};
		window.addEventListener("contextmenu", onContextMenu);
		return () => window.removeEventListener("contextmenu", onContextMenu);
	}, []);

	// 登录后：初始化应用（仅一次）+ 周期心跳（30s）。
	// 退出登录仅两种情形：① 服务端明确拒绝（authRejected：accessKey 失效、用户被封禁、被其它设备顶下线）→ 立即登出；
	// ② 连续 HB_FAILURE_TOLERANCE 次（=5 分钟）都连不上服务端 → 判定服务端关机/长时间不可达，登出。
	// 这 10 次内只要有任意一次连上（r.ok）即清零、绝不回登录页（容忍长时间的网络抖动）。
	useEffect(() => {
		if (!loggedIn) return;
		if (!initedRef.current) {
			initedRef.current = true;
			initApp();
		}
		// 请求台账（第204轮）：登录后启动——载入应用级持久化的在途请求，对「画布流程够不着」的
		// 任务（非激活画布/项目未打开/节点已删）全局兜底轮询与投递；幂等，重复登录只启动一次。
		void import("@/store/requestLedgerStore").then((m) => m.initRequestLedger()).catch(() => {});
		// 多窗口实时同步（第205轮）：单实例多窗口下同项目状态实时镜像（画布/字段/媒体库/运行态）
		// + 单写者写盘；幂等，popout 只读窗口自动跳过。
		void import("@/services/projectSync").then((m) => m.initProjectSync()).catch(() => {});
		hbFailures.current = 0; // 进入会话重置计数
		const HB_INTERVAL_MS = 30000;      // 心跳间隔：30 秒
		const HB_FAILURE_TOLERANCE = 10;   // 连续瞬时失败容差：连续 10 次（≈5 分钟）连不上才登出；其间任一次成功即清零
		const hb = setInterval(async () => {
			const r = await managedClient.heartbeat();
			if (r.ok) {
				hbFailures.current = 0;
				// 全量刷新 user（积分 + features 开关）：管理端改「可用模式」≤30s 生效
				if (r.user) useConnectionStore.getState().setSession(true, r.user);
			} else if (r.authRejected) {
				// 服务端明确拒绝（API 密钥失效 / 用户被禁用 / 被其它设备抢占登录）→ 立即登出
				hbFailures.current = 0;
				useConnectionStore.getState().setSession(false, null);
			} else {
				// 瞬时掉线（网络/超时/5xx）→ 容差：连续失败达到阈值才登出
				hbFailures.current += 1;
				if (hbFailures.current >= HB_FAILURE_TOLERANCE) {
					hbFailures.current = 0;
					useConnectionStore.getState().setSession(false, null);
				}
			}
		}, HB_INTERVAL_MS);
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
	const personalCenterOpen = useUiStore((s) => s.personalCenterOpen);
	const toolboxOpen = useToolboxStore((s) => s.open);

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

	// 弹出窗口：只渲染对应助手（复用上面的启动流程：连接 / catalog / 自动加载项目），不渲染主界面。
	if (isPopout()) {
		return <PopoutView />;
	}

	return (
		<Router>
			<div className="Qiji-shell">
				<TitleBar />
				<RouterView />
				<RouteSnapshotTracker />
				<ThemeBodySync />
				<ModeGuard />
				<FloatingAssistants />
				<Lightbox />
				<AnnotationEditorHost />
				<ViewAngleModalHost />
				<PanoViewerModalHost />
				<DirectorStageModalHost />
				<PromptModal />
				<AssetCheckModal />
				<SharedPickModal />
				<ConfirmModal />
				<TaskRecoveryNotice />
				{settingsOpen && <SettingsModal />}
				{personalCenterOpen && <PersonalCenter />}
				{toolboxOpen && <ToolboxModal />}
			</div>
		</Router>
	);
}