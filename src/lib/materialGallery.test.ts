import { describe, expect, it } from "vitest";
import { createGalleryIdentity, moveGalleryItem } from "./materialGallery";

describe("material gallery identity", () => {
	it("keeps independent IDs for duplicate URI entries across reorder", () => {
		const id = createGalleryIdentity<{ uri: string }>(), a = { uri: "same" }, b = { uri: "same" };
		const first = id(a), second = id(b);
		expect(first).not.toBe(second);
		const moved = moveGalleryItem([a, b], second, first, id)!;
		expect(moved.map(id)).toEqual([second, first]);
	});
	it("resolves IDs against the current list and never inserts deleted entries", () => {
		const id = (item: string) => item;
		expect(moveGalleryItem(["a", "c"], "b", "a", id)).toBeNull();
		expect(moveGalleryItem(["a", "c"], "a", "b", id)).toBeNull();
		expect(moveGalleryItem(["a", "c"], "a", "a", id)).toBeNull();
		expect(moveGalleryItem(["a", "b", "c"], "a", "c", id)).toEqual(["b", "c", "a"]);
	});
});
