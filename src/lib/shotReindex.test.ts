import { describe, it, expect } from "vitest";
import { reindexShots } from "./shotReindex";
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
