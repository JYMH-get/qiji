import { describe, it, expect } from "vitest";
import { nextSupplementIndex, reindexShots, resolveShotMainParents } from "./shotReindex";
import type { StoryboardShot } from "@/services/projectFile";

const shot = (id: string, isSupplement?: boolean): StoryboardShot =>
	({ id, index: 0, title: "旧标题", prompt: "", materials: [], isSupplement } as unknown as StoryboardShot);

describe("reindexShots 重排编号（Frame161195/inferRun/工作台补镜头共用）", () => {
	it("普通镜按序 1,2,3… 且 isSupplement 清 false", () => {
		const r = reindexShots([shot("a"), shot("b"), shot("c")]);
		expect(r.map((s) => s.title)).toEqual(["分镜1", "分镜2", "分镜3"]);
		expect(r.map((s) => s.index)).toEqual([1, 2, 3]);
		expect(r.every((s) => s.isSupplement === false)).toBe(true);
	});

	it("补镜头派生自上一主镜号：分镜2-1、2-2，后续主镜继续 3", () => {
		const r = reindexShots([shot("a"), shot("b"), shot("s1", true), shot("s2", true), shot("c")]);
		expect(r.map((s) => s.title)).toEqual(["分镜1", "分镜2", "分镜2-1", "分镜2-2", "分镜3"]);
		expect(r.map((s) => s.index)).toEqual([1, 2, 3, 4, 5]);
		expect(r[2].isSupplement).toBe(true);
		expect(r[4].isSupplement).toBe(false);
	});

	it("首镜为补镜头（无主镜可派生）→ 降级为主镜", () => {
		const r = reindexShots([shot("s", true), shot("a")]);
		expect(r[0].title).toBe("分镜1");
		expect(r[0].isSupplement).toBe(false);
		expect(r[1].title).toBe("分镜2");
	});

	it("id 与其余字段原样保留、不改原数组", () => {
		const src = [shot("a"), shot("s", true)];
		const r = reindexShots(src);
		expect(r.map((s) => s.id)).toEqual(["a", "s"]);
		expect(src[0].title).toBe("旧标题"); // 入参不被就地改写
		expect(r[1].isSupplement).toBe(true);
	});
});

describe("RTC explicit supplement numbering keeps table compatibility", () => {
	const explicit = (id: string, parent: string, index?: number): StoryboardShot => ({ ...shot(id, true), supplementParentId: parent, supplementIndex: index });
	it("uses a stable parent outside adjacency, including a parent later in the array", () => {
		const result = reindexShots([explicit("before", "a", 2), shot("a"), shot("b"), explicit("after", "a", 1)]);
		expect(result.map(s => s.title)).toEqual(["分镜1-2", "分镜1", "分镜2", "分镜1-1"]);
		expect(result.map(s => s.index)).toEqual([1, 2, 3, 4]);
		const reordered = reindexShots([result[2], result[3], result[1], result[0]]);
		expect(reordered.map(s => s.title)).toEqual(["分镜1", "分镜2-1", "分镜2", "分镜2-2"]);
	});
	it("reserves explicit suffixes before numbering old implicit supplements", () => {
		const result = reindexShots([shot("a"), shot("old", true), explicit("new", "a", 1)]);
		expect(result.map(s => s.title)).toEqual(["分镜1", "分镜1-2", "分镜1-1"]);
		expect(nextSupplementIndex(result, "a")).toBe(3);
	});
	it("clears RTC binding on the table's existing false toggle, so reopening follows the table's previous main", () => {
		const before = reindexShots([shot("a"), shot("b"), explicit("s", "a", 4)]);
		const off = reindexShots(before.map(s => s.id === "s" ? { ...s, isSupplement: false } : s));
		expect(off[2]).toMatchObject({ title: "分镜3", isSupplement: false });
		expect(off[2].supplementParentId).toBeUndefined(); expect(off[2].supplementIndex).toBeUndefined();
		const on = reindexShots(off.map(s => s.id === "s" ? { ...s, isSupplement: true } : s));
		expect(on[2].title).toBe("分镜2-1");
	});
	it("keeps orphan/cyclic explicit bindings and their historical names, never silently attaching to a neighbor", () => {
		const result = reindexShots([shot("a"), { ...explicit("orphan", "gone", 2), title: "分镜8-2" }, explicit("x", "y", 1), explicit("y", "x", 1), explicit("self", "self", 1)]);
		expect(result.slice(1).map(s => s.title)).toEqual(["分镜8-2", "旧标题", "旧标题", "旧标题"]);
		expect(result[1].supplementParentId).toBe("gone"); expect(resolveShotMainParents(result).get("x")).toBeNull();
	});
	it("repairs duplicate or invalid suffixes without discarding media or material fields", () => {
		const result = reindexShots([shot("a"), explicit("s1", "a", 3), { ...explicit("s2", "a", 3), videoUris: ["video"] }, explicit("s3", "a", -1)]);
		expect(result.map(s => s.title)).toEqual(["分镜1", "分镜1-3", "分镜1-1", "分镜1-2"]);
		expect(result[2].videoUris).toEqual(["video"]);
		expect(reindexShots(JSON.parse(JSON.stringify(result)))).toEqual(result);
	});
});
