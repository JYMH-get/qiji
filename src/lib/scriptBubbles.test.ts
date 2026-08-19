import { describe, it, expect } from "vitest";
import { splitScriptBubbles, speakerColor, SPEAKER_PALETTE } from "./scriptBubbles";

describe("splitScriptBubbles 按行拆气泡", () => {
	it("空输入返回空数组", () => {
		expect(splitScriptBubbles("")).toEqual([]);
		expect(splitScriptBubbles(undefined)).toEqual([]);
		expect(splitScriptBubbles(null)).toEqual([]);
	});

	it("空行跳过、行首尾空白剔除、CRLF 与 LF 都认", () => {
		const r = splitScriptBubbles("  第一行  \r\n\r\n\n 第二行\n   \n");
		expect(r).toEqual([
			{ kind: "plain", body: "第一行" },
			{ kind: "plain", body: "第二行" },
		]);
	});

	it("▲/△/（/( 开头判为 action（整行为 body）", () => {
		for (const lead of ["▲", "△", "（", "("]) {
			const r = splitScriptBubbles(`${lead}夜，城楼上`);
			expect(r).toEqual([{ kind: "action", body: `${lead}夜，城楼上` }]);
		}
	});

	it("「人名：台词」判为 dialogue（全半角冒号皆可，人名与正文分离）", () => {
		expect(splitScriptBubbles("孟金珠：你回来了。")).toEqual([
			{ kind: "dialogue", speaker: "孟金珠", body: "你回来了。" },
		]);
		expect(splitScriptBubbles("A1: hello")).toEqual([
			{ kind: "dialogue", speaker: "A1", body: "hello" },
		]);
	});

	it("人名超 6 字 / 含标点 → 不判 dialogue（回退 plain）", () => {
		expect(splitScriptBubbles("贺长安贺长安七：台词")[0].kind).toBe("plain");
		expect(splitScriptBubbles("孟·金珠：台词")[0].kind).toBe("plain");
	});

	it("冒号后可为空台词；无冒号普通行为 plain", () => {
		expect(splitScriptBubbles("旁白：")).toEqual([{ kind: "dialogue", speaker: "旁白", body: "" }]);
		expect(splitScriptBubbles("远处传来钟声")).toEqual([{ kind: "plain", body: "远处传来钟声" }]);
	});

	it("混排剧本逐行分类正确", () => {
		const text = "▲清晨，庭院\n孟金珠：今天天气不错。\n（她抬头看天）\n贺长安：嗯。\n众人散去";
		expect(splitScriptBubbles(text).map((b) => b.kind)).toEqual([
			"action", "dialogue", "action", "dialogue", "plain",
		]);
	});
});

describe("speakerColor 人名着色", () => {
	it("同名恒同色、色值恒在调色板内", () => {
		for (const name of ["孟金珠", "贺长安", "A", "旁白", "昭阳长公主"]) {
			const c = speakerColor(name);
			expect(c).toBe(speakerColor(name));
			expect(SPEAKER_PALETTE).toContain(c);
		}
	});

	it("调色板 ≥8 色且互不重复", () => {
		expect(SPEAKER_PALETTE.length).toBeGreaterThanOrEqual(8);
		expect(new Set(SPEAKER_PALETTE).size).toBe(SPEAKER_PALETTE.length);
	});
});
