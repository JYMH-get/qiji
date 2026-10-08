import { create } from "zustand";

/** 右栏资产编辑器的挂载点。仅 UI 会话状态，不写项目。 */
export const useRtcAssetEditorSlotStore = create<{
  container: HTMLDivElement | null;
  setContainer: (container: HTMLDivElement | null) => void;
}>(set => ({ container: null, setContainer: container => set({ container }) }));
