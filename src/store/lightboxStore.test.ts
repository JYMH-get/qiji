import { afterEach, describe, expect, it, vi } from "vitest";
import { openLightbox, openLightboxGallery, useLightboxStore, type LightboxGallerySource, type LightboxItem } from "./lightboxStore";

const item = (id: string): LightboxItem => ({ id, uri: "same-file.png", media: "image", name: id });
function fixture() {
    let items: LightboxItem[] | null = [item("a"), item("b"), item("c")];
    let writable = true;
    const listeners = new Set<() => void>();
    const notify = () => [...listeners].forEach(fn => fn());
    const source: LightboxGallerySource = {
        getItems: () => items,
        subscribe: fn => { listeners.add(fn); return () => { listeners.delete(fn); }; },
        canReorder: () => writable,
        reorder: vi.fn((from, to) => {
            const next = [...items!];
            const i = next.findIndex(it => it.id === from), j = next.findIndex(it => it.id === to);
            const [moved] = next.splice(i, 1); next.splice(j, 0, moved);
            items = next; notify();
        }),
    };
    return { source, listeners, update: (value: LightboxItem[] | null) => { items = value; notify(); }, lock: () => { writable = false; notify(); } };
}
afterEach(() => useLightboxStore.getState().close());
describe("shared material lightbox lifecycle", () => {
    it("keeps duplicate file references distinct and selected identity across a reorder", () => {
        const f = fixture(); openLightboxGallery(f.source, "b");
        useLightboxStore.getState().reorder("b", "c");
        const s = useLightboxStore.getState();
        expect(s.items.map(it => it.id)).toEqual(["a", "c", "b"]);
        expect(s.item?.id).toBe("b"); expect(s.index).toBe(2);
        expect(f.source.reorder).toHaveBeenCalledOnce();
    });
    it("navigates fresh items, clamps boundaries, and uses the clicked thumbnail ID", () => {
        const f = fixture(); openLightboxGallery(f.source, "a");
        useLightboxStore.getState().move(-1); expect(useLightboxStore.getState().item?.id).toBe("a");
        f.update([item("a"), item("b"), item("c"), { ...item("d"), media: "audio" }]);
        useLightboxStore.getState().select("d"); useLightboxStore.getState().move(1);
        expect(useLightboxStore.getState().item?.media).toBe("audio");
        useLightboxStore.getState().move(-1); expect(useLightboxStore.getState().item?.id).toBe("c");
    });
    it("does not replay a stale source after the project becomes invalid", () => {
        const f = fixture(); openLightboxGallery(f.source, "a");
        f.update(null); useLightboxStore.getState().reorder("a", "b");
        expect(f.source.reorder).not.toHaveBeenCalled();
        expect(useLightboxStore.getState().item).toBeNull(); expect(f.listeners.size).toBe(0);
    });
    it("rechecks dynamic read-only state before mutating", () => {
        const f = fixture(); openLightboxGallery(f.source, "a"); f.lock();
        useLightboxStore.getState().reorder("a", "b");
        expect(f.source.reorder).not.toHaveBeenCalled(); expect(useLightboxStore.getState().sortable).toBe(false);
        useLightboxStore.getState().move(1); expect(useLightboxStore.getState().item?.id).toBe("b");
    });
    it("survives deletion of the current item and closes when nothing remains", () => {
        const f = fixture(); openLightboxGallery(f.source, "b"); f.update([item("a"), item("c")]);
        expect(useLightboxStore.getState().item?.id).toBe("c");
        useLightboxStore.getState().reorder("b", "a"); expect(f.source.reorder).not.toHaveBeenCalled();
        f.update([]); expect(useLightboxStore.getState().item).toBeNull();
    });
    it("releases old subscriptions when another gallery or single preview opens", () => {
        const first = fixture(), second = fixture(); openLightboxGallery(first.source, "a");
        openLightboxGallery(second.source, "b"); first.update(null);
        expect(first.listeners.size).toBe(0); expect(useLightboxStore.getState().item?.id).toBe("b");
        openLightbox({ uri: "single.png" }); second.update(null);
        expect(second.listeners.size).toBe(0); expect(useLightboxStore.getState().item?.uri).toBe("single.png");
        expect(useLightboxStore.getState().sortable).toBe(false);
    });
    it("does not publish redundant gallery renders for unrelated source updates", () => {
        const f = fixture(); openLightboxGallery(f.source, "a");
        const before = useLightboxStore.getState(); f.update([item("a"), item("b"), item("c")]);
        expect(useLightboxStore.getState()).toBe(before);
    });
});
