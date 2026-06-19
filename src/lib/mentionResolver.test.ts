import { describe, it, expect } from "vitest";
import { extractMentions } from "./mentionResolver";

describe("extractMentions", () => {
	it("提取单个 mention", () => {
		const result = extractMentions("这是 @[text] 的引用");
		expect(result).toEqual(["text"]);
	});

	it("提取多个 mention", () => {
		const result = extractMentions("@[text] 和 @[shot] 混合");
		expect(result).toContain("text");
		expect(result).toContain("shot");
		expect(result.length).toBe(2);
	});

	it("去重重复 mention", () => {
		const result = extractMentions("@[text] 再 @[text]");
		expect(result).toEqual(["text"]);
	});

	it("无 mention 返回空数组", () => {
		const result = extractMentions("普通文本没有引用");
		expect(result).toEqual([]);
	});

	it("空字符串返回空数组", () => {
		expect(extractMentions("")).toEqual([]);
	});

	it("混合中英文", () => {
		const result = extractMentions("基于 @[shot] 生成图片");
		expect(result).toEqual(["shot"]);
	});
});