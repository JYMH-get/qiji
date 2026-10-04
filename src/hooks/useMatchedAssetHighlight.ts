import { useEffect, type RefObject } from "react";
import { shallow } from "zustand/shallow";
import { matchedAssetTextRanges } from "@/lib/assetMatch";
import { useProjectStore } from "@/store/projectStore";
import type { ShotMaterial } from "@/services/projectFile";

const editors = new Map<HTMLElement, Range[]>();
const highlightName = "qiji-matched-asset";

function refreshHighlight() {
    const HighlightCtor = (globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
    const registry = (globalThis.CSS as unknown as { highlights?: Map<string, unknown> } | undefined)?.highlights;
    if (!HighlightCtor || !registry) return;
    const ranges = [...editors.values()].flat();
    if (ranges.length) registry.set(highlightName, new HighlightCtor(...ranges));
    else registry.delete(highlightName);
}

/** CSS Highlight 只改变字色，不拆编辑器 DOM，不影响光标、中文输入或保存的纯文本。 */
export function useMatchedAssetHighlight(root: RefObject<HTMLElement>, text: string, materials: ShotMaterial[]) {
    const assets = useProjectStore((s) => [s.characters, s.crowds, s.scenes, s.organisms, s.items, s.assetBlobs], shallow);
    useEffect(() => {
        const el = root.current;
        if (!el) return;
        let frame = 0;
        const update = () => {
            const segments: Array<{ node: Text; start: number; end: number }> = [];
            let offset = 0;
            const walk = (node: Node) => {
                if (node.nodeType === Node.TEXT_NODE) {
                    const end = offset + (node.textContent?.length ?? 0);
                    segments.push({ node: node as Text, start: offset, end });
                    offset = end;
                } else if (node.nodeType === Node.ELEMENT_NODE) {
                    const child = node as HTMLElement;
                    if (child.dataset.sourceText !== undefined) offset += child.dataset.sourceText.length;
                    else if (child.dataset.tag) offset += child.dataset.tag.length;
                    else if (child.tagName === "BR") offset++;
                    else child.childNodes.forEach(walk);
                }
            };
            el.childNodes.forEach(walk);
            const ranges: Range[] = [];
            for (const hit of matchedAssetTextRanges(text, materials)) {
                const start = segments.find((s) => s.start <= hit.start && hit.start < s.end);
                const end = segments.find((s) => s.start < hit.end && hit.end <= s.end);
                if (!start || !end) continue;
                const range = document.createRange();
                range.setStart(start.node, hit.start - start.start);
                range.setEnd(end.node, hit.end - end.start);
                ranges.push(range);
            }
            editors.set(el, ranges);
            refreshHighlight();
        };
        // 模式切换、预设刷新和失焦重绘可能只重建 DOM，text/materials 并未变化。
        // 旧 Range 会随旧文字节点移除而折叠，必须在新节点上重新绑定；合并到下一帧避免重复扫描。
        const schedule = () => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(update);
        };
        const observer = new MutationObserver(schedule);
        observer.observe(el, { childList: true, subtree: true, characterData: true });
        schedule();
        return () => {
            observer.disconnect();
            cancelAnimationFrame(frame);
            editors.delete(el);
            refreshHighlight();
        };
    }, [root, text, materials, assets]);
}
