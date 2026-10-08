import { useEffect, useRef, useState } from "react";
import { useLightboxStore, type LightboxItem } from "@/store/lightboxStore";
import { useLightboxDisplayUri } from "@/hooks/useLightboxDisplayUri";

function Thumbnail({ item }: { item: LightboxItem }) {
    const uri = useLightboxDisplayUri(item.thumbnailUri || item.uri);
    return item.thumbnailUri || (item.media || "image") === "image"
        ? <img src={uri} alt="" draggable={false} />
        : item.media === "video"
            ? <video src={uri} muted preload="metadata" playsInline draggable={false} />
            : <span className="lightbox-audio-thumb">♫</span>;
}

const mediaLabels = { image: "图片", video: "视频", audio: "音频" };
export function lightboxLabels(items: LightboxItem[]): string[] {
    const counts = { image: 0, video: 0, audio: 0 };
    return items.map(it => {
        const media = it.media || "image";
        counts[media]++;
        return it.label || `${mediaLabels[media]}${counts[media]}`;
    });
}

export function LightboxGallery() {
    const { items, item, index, sortable, select, reorder, error } = useLightboxStore();
    const strip = useRef<HTMLDivElement>(null);
    const dragged = useRef<{ id: string; source: unknown } | null>(null);
    const [over, setOver] = useState<string | null>(null);
    const labels = lightboxLabels(items);
    useEffect(() => {
        strip.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }, [index, items]);
    if (!item?.id) return null;
    return <div className="lightbox-gallery" onClick={e => e.stopPropagation()} onMouseDown={e => e.stopPropagation()}>
        <div ref={strip} className="lightbox-filmstrip" aria-label="素材顺序">
            {items.map((it, i) => <button key={it.id} type="button"
                className={`lightbox-thumb${over === it.id ? " is-drop-target" : ""}`}
                aria-label={`${labels[i]}${it.name ? ` · ${it.name}` : ""}`}
                aria-current={i === index ? "true" : undefined}
                title={`${labels[i]}${it.name ? ` · ${it.name}` : ""}${sortable ? "（拖动排序）" : ""}`}
                draggable={sortable}
                onClick={() => select(it.id!)}
                onKeyDown={e => {
                    if (!sortable || !e.altKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
                    e.preventDefault(); e.stopPropagation();
                    const target = items[i + (e.key === "ArrowLeft" ? -1 : 1)];
                    if (target?.id) reorder(it.id!, target.id);
                }}
                onDragStart={e => {
                    const state = useLightboxStore.getState();
                    state.refresh();
                    if (!useLightboxStore.getState().sortable) { e.preventDefault(); return; }
                    dragged.current = { id: it.id!, source: state.source };
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("application/x-qiji-lightbox-material", it.id!);
                    e.stopPropagation();
                }}
                onDragEnd={() => { dragged.current = null; setOver(null); }}
                onDragOver={e => {
                    if (!sortable || !dragged.current || dragged.current.source !== useLightboxStore.getState().source) return;
                    e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = "move";
                    setOver(it.id!);
                }}
                onDragLeave={() => setOver(null)}
                onDrop={e => {
                    e.preventDefault(); e.stopPropagation();
                    const drag = dragged.current;
                    dragged.current = null; setOver(null);
                    if (drag && drag.source === useLightboxStore.getState().source) reorder(drag.id, it.id!);
                }}>
                <Thumbnail item={it} />
                <span className="lightbox-thumb-label">{labels[i]}</span>
            </button>)}
        </div>
        {error && <span role="alert" className="lightbox-gallery-error">{error}</span>}
    </div>;
}
