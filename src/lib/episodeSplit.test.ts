import { describe, it, expect } from "vitest";
import { splitEpisodes } from "./episodeSplit";

/** 剧集分集 4 种确定性切分（与资产模式一致）。 */
describe("episodeSplit · 4 种分集方式", () => {
	it("按第N集/章/回", () => {
		const r = splitEpisodes("第1集\n甲的故事\n第2集\n乙的故事", "按第N集");
		expect(r.length).toBe(2);
		expect(r[0].scriptText).toContain("甲");
		expect(r[1].scriptText).toContain("乙");
	});

	it("按双换行（空行）", () => {
		const r = splitEpisodes("块A\n\n块B\n\n块C", "按双换行");
		expect(r.map((e) => e.title)).toEqual(["第1集", "第2集", "第3集"]);
	});

	it("n-n（逐编号）含 0-引言", () => {
		const r = splitEpisodes("引言\n1-1 a\n1-2 b\n2-1 c", "n-n");
		expect(r.map((e) => e.title)).toEqual(["0-引言", "1-1", "1-2", "2-1"]);
	});

	it("n-1（逐主编号）", () => {
		const r = splitEpisodes("引言\n1-1 a\n1-2 b\n2-1 c\n2-2 d\n3-1 e", "n-1");
		expect(r.map((e) => e.title)).toEqual(["0-引言", "1-1", "2-1", "3-1"]);
	});

	it("无编号标记时 n-n 返回空（由调用方提示换方式）", () => {
		expect(splitEpisodes("没有编号的文本", "n-n").length).toBe(0);
	});

	it("容差「场」前缀：场n-n 也能用 n-n 拆", () => {
		const r = splitEpisodes("引言\n场1-1 a\n场1-2 b\n场2-1 c", "n-n");
		expect(r.map((e) => e.title)).toEqual(["0-引言", "1-1", "1-2", "2-1"]);
	});

	it("容差「场」前缀：场n-n 也能用 n-1 拆（逐主编号）", () => {
		const r = splitEpisodes("场1-1 a\n场1-2 b\n场2-1 c\n场3-1 d", "n-1");
		expect(r.map((e) => e.title)).toEqual(["1-1", "2-1", "3-1"]);
	});

	it("按第N集无标记时整段作 1 集", () => {
		const r = splitEpisodes("一段没有集标记的剧本", "按第N集");
		expect(r.length).toBe(1);
		expect(r[0].title).toBe("第1集");
	});
});
