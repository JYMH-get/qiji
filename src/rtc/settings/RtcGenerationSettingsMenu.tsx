import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useProjectStore } from "@/store/projectStore";
import { usePromptModalStore } from "@/store/promptModalStore";
import { setRtcShortcutsSuspended } from "../timeline/rtcKeymap";
import { RtcGenerationSettings } from "./RtcGenerationSettings";
import { useRtcSettingsModal } from "./rtcSettingsModalStore";

interface MenuProps {
    anchorRef: RefObject<HTMLButtonElement>;
}

/** 视频设置始终从工具栏向上展开；Portal 避免被时间轴/分栏容器裁切。 */
function GenerationMenuBody({ anchorRef }: MenuProps) {
    const panelRef = useRef<HTMLDivElement>(null);
    const insidePointerEvent = useRef<Event | null>(null);
    const childPortalKeyEvent = useRef<Event | null>(null);
    const owner = useProjectStore(s => s.projectInstanceId);
    const openedOwner = useRef(owner);
    const close = useRtcSettingsModal(s => s.close);
    const [position, setPosition] = useState<{ left: number; bottom: number; width: number; maxHeight: number } | null>(null);

    useLayoutEffect(() => {
        const updatePosition = () => {
            const anchor = anchorRef.current;
            if (!anchor) return;
            const rect = anchor.getBoundingClientRect();
            const width = Math.min(480, window.innerWidth - 24);
            setPosition({
                left: Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12)),
                bottom: window.innerHeight - rect.top + 6,
                width,
                maxHeight: Math.max(0, Math.min(600, rect.top - 18)),
            });
        };
        updatePosition();
        const observer = new ResizeObserver(updatePosition);
        if (anchorRef.current) {
            observer.observe(anchorRef.current);
            if (anchorRef.current.parentElement) observer.observe(anchorRef.current.parentElement);
        }
        window.addEventListener("resize", updatePosition);
        window.addEventListener("scroll", updatePosition, true);
        return () => {
            observer.disconnect();
            window.removeEventListener("resize", updatePosition);
            window.removeEventListener("scroll", updatePosition, true);
        };
    }, [anchorRef]);

    useEffect(() => {
        setRtcShortcutsSuspended(true);
        return () => setRtcShortcutsSuspended(false);
    }, []);

    const positioned = position !== null;
    useEffect(() => {
        if (positioned) panelRef.current?.focus({ preventScroll: true });
    }, [positioned]);

    useEffect(() => {
        const onPointerDown = (event: PointerEvent) => {
            // React Portal 保留事件祖先；全局提示词编辑器则由独立 store 持有。
            if (insidePointerEvent.current === event || usePromptModalStore.getState().open) return;
            const target = event.target as Node;
            if (!panelRef.current?.contains(target) && !anchorRef.current?.contains(target)) close();
        };
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== "Escape" || event.defaultPrevented || childPortalKeyEvent.current === event || usePromptModalStore.getState().open) return;
            event.preventDefault();
            close();
            anchorRef.current?.focus();
        };
        window.addEventListener("pointerdown", onPointerDown);
        window.addEventListener("keydown", onKeyDown);
        return () => {
            window.removeEventListener("pointerdown", onPointerDown);
            window.removeEventListener("keydown", onKeyDown);
        };
    }, [anchorRef, close]);

    // 换项目关闭旧菜单，避免把上一项目的设置编辑延续到新项目。
    useEffect(() => {
        if (owner !== openedOwner.current) close();
    }, [owner, close]);

    return createPortal(<div
        ref={panelRef}
        id="rtc-generation-settings-menu"
        data-rtc-generation-menu
        role="region"
        aria-label="视频生成设置"
        tabIndex={-1}
        onPointerDownCapture={event => { insidePointerEvent.current = event.nativeEvent; }}
        onKeyDownCapture={event => {
            if (!panelRef.current?.contains(event.target as Node)) childPortalKeyEvent.current = event.nativeEvent;
        }}
        style={{
            position: "fixed", zIndex: 10501, outline: "none",
            visibility: position ? "visible" : "hidden",
            ...position,
            display: "flex", flexDirection: "column", overflow: "hidden",
            border: "1px solid rgba(255,255,255,0.14)", borderRadius: 10,
            background: "#16181f", boxShadow: "0 -8px 32px rgba(0,0,0,0.4)",
        }}
    >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0, padding: "10px 12px", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: "rgba(255,255,255,0.9)" }}>视频设置</span>
            <button type="button" aria-label="收起视频设置" title="收起（Esc）" onClick={() => { close(); anchorRef.current?.focus(); }}
                style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 24, height: 24, borderRadius: 5, border: "none", background: "transparent", color: "rgba(255,255,255,0.6)", cursor: "pointer" }}>
                <X size={14} />
            </button>
        </div>
        <RtcGenerationSettings />
    </div>, document.body);
}

export function RtcGenerationSettingsMenu(props: MenuProps) {
    const open = useRtcSettingsModal(s => s.open && s.tab === "generation");
    return open ? <GenerationMenuBody {...props} /> : null;
}
