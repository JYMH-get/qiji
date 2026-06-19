import { describe, it, expect } from "vitest";
import { fuzzyMatch, fuzzyFilter, fuzzyFilterMulti } from "./fuzzyMatch";

describe("fuzzyMatch", () => {
	it("空 query 始终匹配", () => {
		const r = fuzzyMatch("", "任意文本");
		expect(r.match).toBe(true);
		expect(r.score).toBe(0);
	});

	it("完全相等得最高分", () => {
		const r = fuzzyMatch("hello", "hello");
		expect(r.match).toBe(true);
		expect(r.score).toBe(1000);
	});

	it("前缀匹配得分高于子串", () => {
		const prefix = fuzzyMatch("he", "hello world");
		const substr = fuzzyMatch("lo", "hello world");
		expect(prefix.match).toBe(true);
		expect(substr.match).toBe(true);
		expect(prefix.score).toBeGreaterThan(substr.score);
	});

	it("子串包含匹配", () => {
		const r = fuzzyMatch("world", "hello world");
		expect(r.match).toBe(true);
		expect(r.score).toBeGreaterThan(0);
	});

	it("拼音首字母匹配", () => {
		const r = fuzzyMatch("tp", "图片");
		expect(r.match).toBe(true);
	});

	it("不匹配返回 false", () => {
		const r = fuzzyMatch("xyz", "hello");
		expect(r.match).toBe(false);
		expect(r.score).toBe(0);
	});

	it("大小写不敏感", () => {
		const r = fuzzyMatch("HELLO", "hello world");
		expect(r.match).toBe(true);
	});
});

describe("fuzzyFilter", () => {
	it("按 score 降序排列", () => {
		const items = ["hello world", "hello", "world hello", "nothing"];
		const results = fuzzyFilter(items, "hello", (s) => s);
		expect(results.length).toBeGreaterThan(0);
		// "hello" 完全匹配应排第一
		expect(results[0].item).toBe("hello");
	});

	it("过滤不匹配项", () => {
		const items = ["apple", "banana", "cherry"];
		const results = fuzzyFilter(items, "xyz", (s) => s);
		expect(results.length).toBe(0);
	});
});

describe("fuzzyFilterMulti", () => {
	it("多字段取最高分", () => {
		interface Item { name: string; desc: string; }
		const items: Item[] = [
			{ name: "图片", desc: "AI 图片生成" },
			{ name: "脚本", desc: "剧本拆分" },
		];
		// 搜索 "AI" 应该命中第一项的 desc
		const results = fuzzyFilterMulti(items, "AI", [
			(i) => i.name,
			(i) => i.desc,
		]);
		expect(results.length).toBe(1);
		expect(results[0].item.name).toBe("图片");
	});
});