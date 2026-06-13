import { create } from "zustand";

export interface ContextMenuState {
	x: number;
	y: number;
	nodeId: string | null;
	edgeId?: string | null;
}

interface UiState {
	selectedNodeIds: string[];
	activeNodeId: string | null;
	assetPanelOpen: boolean;
	contextMenu: ContextMenuState | null;
	snapToGrid: boolean;
	showMinimap: boolean;
	settingsOpen: boolean;

	// 导航与登录状态
	currentScreen: "login" | "dashboard" | "canvas";
	currentUser: string | null;

	setSelection: (ids: string[]) => void;
	setActiveNodeId: (id: string | null) => void;
	toggleAssetPanel: () => void;
	openContextMenu: (menu: ContextMenuState) => void;
	closeContextMenu: () => void;
	toggleSnapToGrid: () => void;
	toggleMinimap: () => void;
	setSettingsOpen: (open: boolean) => void;

	setScreen: (screen: "login" | "dashboard" | "canvas") => void;
	setCurrentUser: (user: string | null) => void;
}

const initialUser = localStorage.getItem("Qiji:currentUser");

export const useUiStore = create<UiState>((set) => ({
	selectedNodeIds: [],
	activeNodeId: null,
	assetPanelOpen: true,
	contextMenu: null,
	snapToGrid: false,
	showMinimap: true,
	settingsOpen: false,

	currentScreen: initialUser ? "dashboard" : "login",
	currentUser: initialUser,

	setSelection: (ids) => set({ selectedNodeIds: ids }),
	setActiveNodeId: (id) => set({ activeNodeId: id }),
	toggleAssetPanel: () => set((s) => ({ assetPanelOpen: !s.assetPanelOpen })),
	openContextMenu: (menu) => set({ contextMenu: menu }),
	closeContextMenu: () => set({ contextMenu: null }),
	toggleSnapToGrid: () => set((s) => ({ snapToGrid: !s.snapToGrid })),
	toggleMinimap: () => set((s) => ({ showMinimap: !s.showMinimap })),
	setSettingsOpen: (open) => set({ settingsOpen: open }),

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
