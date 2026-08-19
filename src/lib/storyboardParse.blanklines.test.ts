import { describe, it, expect } from "vitest";
import { stripBlankLines } from "./storyboardParse";

/** 分镜原文「空行不是分格」：解析落盘与外显分格共用的去空行语义 */
describe("stripBlankLines", () => {
	it("去掉空行与只含空白的行，保留内容行顺序", () => {
		expect(stripBlankLines("人物：林凡\n\n（动作）冲天而起。\n \t \n收尾")).toBe(
			"人物：林凡\n（动作）冲天而起。\n收尾",
		);
	});

	it("CRLF 同样处理；首尾空行剥净", () => {
		expect(stripBlankLines("\r\n场17-1 葬神秘境\r\n\r\n夜\r\n")).toBe("场17-1 葬神秘境\n夜");
	});

	it("全空文本 → 空串；无空行文本原样", () => {
		expect(stripBlankLines("\n \n")).toBe("");
		expect(stripBlankLines("一行")).toBe("一行");
	});
});
