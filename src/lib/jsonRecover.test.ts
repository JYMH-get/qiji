import { describe, it, expect } from "vitest";
import { recoverArrayElements } from "./jsonRecover";

describe("recoverArrayElements", () => {
	it("从完整闭合数组取出全部元素", () => {
		const out = recoverArrayElements('[{"a":1},{"a":2}]');
		expect(out).toEqual([{ a: 1 }, { a: 2 }]);
	});

	it("数组未闭合：只取已完整的元素，丢弃末尾不完整对象", () => {
		// 第三个对象缺右花括号与右方括号（流式中途）
		const partial = '[{"i":1,"s":"a"},{"i":2,"s":"b"},{"i":3,"s":"c';
		const out = recoverArrayElements(partial);
		expect(out).toEqual([{ i: 1, s: "a" }, { i: 2, s: "b" }]);
	});

	it("容忍字符串内的花括号/方括号/转义引号（不误判结构）", () => {
		const partial = '[{"p":"含 {大括号} 和 \\"引号\\" 与 [方括号]"},{"p":"第二段不完整';
		const out = recoverArrayElements(partial);
		expect(out).toEqual([{ p: '含 {大括号} 和 "引号" 与 [方括号]' }]);
	});

	it("前缀有思考过程/代码块围栏时仍能定位首个 [", () => {
		const partial = '思考：先这样。\n```json\n[{"i":1},{"i":2}]';
		const out = recoverArrayElements(partial);
		expect(out).toEqual([{ i: 1 }, { i: 2 }]);
	});

	it("没有数组时返回空", () => {
		expect(recoverArrayElements("纯文字没有 JSON")).toEqual([]);
		expect(recoverArrayElements("")).toEqual([]);
	});
});
