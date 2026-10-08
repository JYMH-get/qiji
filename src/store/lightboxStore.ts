/**
 * lightboxStore —— 全局图片/视频/音频放大灯箱（任意界面双击图片即可「查看大图」）。
 * 灯箱底部信息栏显示资产名 + 分辨率（图片自然宽高 / 视频帧宽高），统一各界面的放大体验。
 */
import { create } from "zustand";
import type { MediaKind } from "@/lib/shotMaterials";

export interface LightboxItem {
    /** 列表内的稳定身份，不能仅用 URI（同一文件可以重复引用）。 */
    id?: string;
    uri: string;
    label?: string;
    thumbnailUri?: string;
    /** 资产名（信息栏左侧显示） */
    name?: string;
    /** 模态：image（默认）/ video / audio */
    media?: MediaKind;
    /** 该资产绑定的音色（资产助手放大时传入）：信息栏显示「已绑定音色」并可播放 */
    voiceUri?: string;
    voiceName?: string;
}

/** 来源保留排序规则与所有权；灯箱不保存第二份业务素材数组。 */
export interface LightboxGallerySource {
    getItems: () => LightboxItem[] | null;
    subscribe?: (listener: () => void) => () => void;
    reorder?: (fromId: string, toId: string) => void;
    canReorder?: () => boolean;
}

interface LightboxState {
    item: LightboxItem | null;
    items: LightboxItem[];
    index: number;
    source: LightboxGallerySource | null;
    sortable: boolean;
    error: string | null;
    open: (item: LightboxItem) => void;
    openGallery: (source: LightboxGallerySource, activeId: string) => void;
    refresh: () => void;
    select: (id: string) => void;
    move: (delta: number) => void;
    reorder: (fromId: string, toId: string) => void;
    close: () => void;
}

let unsubscribe: (() => void) | undefined;
const detach = () => { const fn = unsubscribe; unsubscribe = undefined; fn?.(); };
const sameItem = (a: LightboxItem, b: LightboxItem) =>
    a.id === b.id && a.uri === b.uri && a.name === b.name && a.media === b.media
    && a.label === b.label && a.thumbnailUri === b.thumbnailUri
    && a.voiceUri === b.voiceUri && a.voiceName === b.voiceName;
function readItems(source: LightboxGallerySource): LightboxItem[] | null {
    const items = source.getItems();
    if (!items) return null;
    const ids = new Set<string>();
    return items.filter(it => {
        if (!it.uri || !it.id || ids.has(it.id)) return false;
        ids.add(it.id);
        return true;
    });
}

export const useLightboxStore = create<LightboxState>((set, get) => ({
    item: null, items: [], index: 0, source: null, sortable: false, error: null,
    open: (item) => {
        detach();
        set({ item, items: [item], index: 0, source: null, sortable: false, error: null });
    },
    openGallery: (source, activeId) => {
        detach();
        const items = readItems(source);
        if (!items?.length) { get().close(); return; }
        const index = Math.max(0, items.findIndex(it => it.id === activeId));
        set({ items, index, item: items[index], source, sortable: !!source.reorder && (source.canReorder?.() ?? true), error: null });
        const dispose = source.subscribe?.(() => { if (get().source === source) get().refresh(); });
        if (get().source === source) unsubscribe = dispose;
        else dispose?.();
    },
    refresh: () => {
        const state = get();
        if (!state.source) return;
        const items = readItems(state.source);
        if (!items?.length) { state.close(); return; }
        const found = items.findIndex(it => it.id === state.item?.id);
        const index = found < 0 ? Math.min(state.index, items.length - 1) : found;
        const sortable = !!state.source.reorder && (state.source.canReorder?.() ?? true);
        if (state.index === index && state.sortable === sortable && items.length === state.items.length
            && items.every((it, i) => sameItem(it, state.items[i]))) return;
        set({ items, index, item: items[index], sortable });
    },
    select: (id) => {
        get().refresh();
        const { items } = get();
        const index = items.findIndex(it => it.id === id);
        if (index >= 0) set({ item: items[index], index, error: null });
    },
    move: (delta) => {
        get().refresh();
        const state = get();
        if (!state.items.length) return;
        const index = Math.min(state.items.length - 1, Math.max(0, state.index + delta));
        set({ item: state.items[index], index, error: null });
    },
    reorder: (fromId, toId) => {
        const source = get().source;
        get().refresh();
        const state = get();
        if (!source || state.source !== source || !state.sortable || fromId === toId
            || !state.items.some(it => it.id === fromId) || !state.items.some(it => it.id === toId)) return;
        try {
            source.reorder?.(fromId, toId);
            if (get().source === source) { get().refresh(); set({ error: null }); }
        } catch (error) {
            console.warn("Lightbox material reorder failed", error);
            if (get().source === source) set({ error: "素材排序失败，请重试" });
        }
    },
    close: () => {
        detach();
        set({ item: null, items: [], index: 0, source: null, sortable: false, error: null });
    },
}));

/** 便捷打开灯箱（组件外可直接调用） */
export const openLightbox = (item: LightboxItem) => useLightboxStore.getState().open(item);
export const openLightboxGallery = (source: LightboxGallerySource, activeId: string) => useLightboxStore.getState().openGallery(source, activeId);
