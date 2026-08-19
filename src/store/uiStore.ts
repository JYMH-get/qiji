import { create } from "zustand";

export interface ContextMenuState {
	x: number;
	y: number;
	nodeId: string | null;
	edgeId?: string | null;
}

interface UiState {
	selectedNodeIds: string[];
	/** 框选/点选选中的连线 id（连线批量删除用） */
	selectedEdgeIds: string[];
	activeNodeId: string | null;
	assetPanelOpen: boolean;
	contextMenu: ContextMenuState | null;
	/** 网格点阵显隐（画布背景） */
	showGrid: boolean;
	showMinimap: boolean;
	/** 允许节点重叠：开=关闭拖拽落子/新建节点的自动避让 */
	allowOverlap: boolean;
	/** 节点间吸附对齐：开=拖动节点时自动对齐其它节点的边缘/中线（会话态，默认开） */
	snapAlign: boolean;
	settingsOpen: boolean;
	/** 打开设置弹窗时要定位到的页签（openModelSettings 写入，SettingsModal 消费后清空）。
	 *  第132轮删「模型」页：openModelSettings 改定位「管理端」页（无可用模型=没连管理端/目录未拉取）。 */
	settingsTab: "connection" | "preferences" | "keymap" | "webdav" | null;
	personalCenterOpen: boolean;
	imageEditNodeId: string | null;
	nodeInfoNodeId: string | null;
	/** 节点媒体处理弹窗（超分/去字幕/图像超分/分段/宫格切分/原文拆分/绑定到资产 bindAsset/绑定音色 bindVoice）——悬停工具栏与右键菜单共同入口，NodeProcessModals 全局渲染 */
	nodeProcModal: { nodeId: string; kind: "upscale" | "desub" | "imageUpscale" | "clip" | "gridSplit" | "scriptSplit" | "bindAsset" | "bindVoice" } | null;
	/** 堆叠抽屉：当前展开抽屉的节点 id（右键「打开堆叠」/快捷键 C；同时只开一个，会话态） */
	stackDrawerNodeId: string | null;
	/** 拖节点悬停在同类图片/视频节点上（准备并入堆叠）：hover=悬停中，armed=已满 1.5 秒松开即并入 */
	stackMerge: { targetId: string; armed: boolean } | null;
	/** 吸附对齐参考线（拖动吸附命中时显示，标出对齐到的节点；画布坐标） */
	snapGuides: { axis: "x" | "y"; value: number; from: number; to: number }[] | null;

	// 导航与登录状态
	currentScreen: "login" | "dashboard" | "canvas";
	currentUser: string | null;

	setSelection: (ids: string[]) => void;
	setEdgeSelection: (ids: string[]) => void;
	setActiveNodeId: (id: string | null) => void;
	toggleAssetPanel: () => void;
	openContextMenu: (menu: ContextMenuState) => void;
	closeContextMenu: () => void;
	toggleShowGrid: () => void;
	toggleMinimap: () => void;
	toggleAllowOverlap: () => void;
	toggleSnapAlign: () => void;
	setSettingsOpen: (open: boolean) => void;
	/** 打开设置并定位「管理端」页——所有「无可用模型」的入口统一走它（第132轮：模型全量默认可用，
	 *  没有模型=没连管理端/目录未拉取，引导去连接；不再有「模型」页） */
	openModelSettings: () => void;
	setPersonalCenterOpen: (open: boolean) => void;
	setImageEditNodeId: (id: string | null) => void;
	setNodeInfoNodeId: (id: string | null) => void;
	setNodeProcModal: (m: UiState["nodeProcModal"]) => void;
	setStackDrawerNodeId: (id: string | null) => void;
	setStackMerge: (m: UiState["stackMerge"]) => void;
	setSnapGuides: (g: UiState["snapGuides"]) => void;

	setScreen: (screen: "login" | "dashboard" | "canvas") => void;
	setCurrentUser: (user: string | null) => void;
}

// vitest(node) 环境无 localStorage：守卫取值（浏览器行为不变）
const initialUser = typeof localStorage !== "undefined" ? localStorage.getItem("Qiji:currentUser") : null;

/** 选区 id 表内容相同即跳过写入——RF onSelectionChange 每次给新数组，直写会造成
 *  「写 store → Canvas 重渲染 → RF 收新 props → 再触发 onSelectionChange」的无限更新循环 */
const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i]);

export const useUiStore = create<UiState>((set, get) => ({
	selectedNodeIds: [],
	selectedEdgeIds: [],
	activeNodeId: null,
	assetPanelOpen: true,
	contextMenu: null,
	showGrid: true,
	showMinimap: true,
	allowOverlap: false,
	snapAlign: true,
	settingsOpen: false,
	settingsTab: null,
	personalCenterOpen: false,
	imageEditNodeId: null,
	nodeInfoNodeId: null,
	nodeProcModal: null,
	stackDrawerNodeId: null,
	stackMerge: null,
	snapGuides: null,

	currentScreen: initialUser ? "dashboard" : "login",
	currentUser: initialUser,

	setSelection: (ids) => {
		if (!sameIds(get().selectedNodeIds, ids)) set({ selectedNodeIds: ids });
	},
	setEdgeSelection: (ids) => {
		if (!sameIds(get().selectedEdgeIds, ids)) set({ selectedEdgeIds: ids });
	},
	setActiveNodeId: (id) => set({ activeNodeId: id }),
	toggleAssetPanel: () => set((s) => ({ assetPanelOpen: !s.assetPanelOpen })),
	openContextMenu: (menu) => set({ contextMenu: menu }),
	closeContextMenu: () => set({ contextMenu: null }),
	toggleShowGrid: () => set((s) => ({ showGrid: !s.showGrid })),
	toggleMinimap: () => set((s) => ({ showMinimap: !s.showMinimap })),
	toggleAllowOverlap: () => set((s) => ({ allowOverlap: !s.allowOverlap })),
	toggleSnapAlign: () => set((s) => ({ snapAlign: !s.snapAlign })),
	setSettingsOpen: (open) => set(open ? { settingsOpen: true } : { settingsOpen: false, settingsTab: null }),
	openModelSettings: () => set({ settingsOpen: true, settingsTab: "connection" }),
	setPersonalCenterOpen: (open) => set({ personalCenterOpen: open }),
	setImageEditNodeId: (id) => set({ imageEditNodeId: id }),
	setNodeInfoNodeId: (id) => set({ nodeInfoNodeId: id }),
	setNodeProcModal: (m) => set({ nodeProcModal: m }),
	setStackDrawerNodeId: (id) => set({ stackDrawerNodeId: id }),
	setStackMerge: (m) => set({ stackMerge: m }),
	setSnapGuides: (g) => set({ snapGuides: g }),

	setScreen: (currentScreen) => set({ currentScreen }),
	setCurrentUser: (currentUser) => {
		if (currentUser) {
			localStorage.setItem("Qiji:currentUser", currentUser);
		} else {
			localStorage.removeItem("Qiji:currentUser");
		}
		set({ currentUser });
	},
}));

/** 底部面板针对“当前选中的单个节点” */
export function useActiveNodeId(): string | null {
	return useUiStore((s) => s.activeNodeId);
}
