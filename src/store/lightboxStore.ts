/**
 * lightboxStore —— 全局图片/视频/音频放大灯箱（任意界面双击图片即可「查看大图」）。
 * 灯箱底部信息栏显示资产名 + 分辨率（图片自然宽高 / 视频帧宽高），统一各界面的放大体验。
 */
import { create } from "zustand";
import type { MediaKind } from "@/lib/shotMaterials";

export interface LightboxItem {
    uri: string;
    /** 资产名（信息栏左侧显示） */
    name?: string;
    /** 模态：image（默认）/ video / audio */
    media?: MediaKind;
    /** 该资产绑定的音色（资产助手放大时传入）：信息栏显示「已绑定音色」并可播放 */
    voiceUri?: string;
    voiceName?: string;
}

interface LightboxState {
    item: LightboxItem | null;
    open: (item: LightboxItem) => void;
    close: () => void;
}

export const useLightboxStore = create<LightboxState>((set) => ({
    item: null,
    open: (item) => set({ item }),
    close: () => set({ item: null }),
}));

/** 便捷打开灯箱（组件外可直接调用） */
export const openLightbox = (item: LightboxItem) => useLightboxStore.getState().open(item);
