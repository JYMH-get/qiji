import { describe, it, expect } from "vitest";
import { parseInferCards, parseInferCardsStream, extractCardsLoose } from "./smartInferPrompts";

/** 智能推理输出（JSON cards）解析。 */
describe("parseInferCards", () => {
	it("解析 cards JSON 数组（4 字段）", () => {
		const json = JSON.stringify([
			{ card_number: "第1卡", original_script: "陆沉霄暴退", storyboard_prompts: "宫格故事板A", video_prompts: "视频提示词A" },
			{ card_number: "第2卡", original_script: "楚长生僵住", storyboard_prompts: "宫格故事板B", video_prompts: "视频提示词B" },
		]);
		const cards = parseInferCards(json);
		expect(cards.length).toBe(2);
		expect(cards[0].title).toBe("第1卡");
		expect(cards[0].script).toContain("陆沉霄");
		expect(cards[0].storyboardPrompt).toBe("宫格故事板A");
		expect(cards[1].videoPrompt).toBe("视频提示词B");
	});

	it("容忍 ```json 代码块 + 前后思考噪声", () => {
		const text =
			"【导演思考面板】…\n```json\n" +
			JSON.stringify([{ card_number: "第1卡", original_script: "x", storyboard_prompts: "s", video_prompts: "v" }]) +
			"\n```\n（输出完毕）";
		const cards = parseInferCards(text);
		expect(cards.length).toBe(1);
		expect(cards[0].script).toBe("x");
	});

	it("单对象（非数组）也兼容（单分镜模式兜底）", () => {
		const cards = parseInferCards(JSON.stringify({ card_number: "第1卡", original_script: "s", storyboard_prompts: "sb", video_prompts: "vp" }));
		expect(cards.length).toBe(1);
		expect(cards[0].storyboardPrompt).toBe("sb");
	});

	it("容错：字符串内裸换行 + 字面花括号公式（JSON.parse 会失败）", () => {
		// 模型常产出的「人眼正常、JSON 非法」串：字段值含真实换行 + {角色:名}/{场景:名}
		const dirty =
			'[{"card_number":"第1卡","original_script":"楚长生走入大殿\n抬头看天","storyboard_prompts":"【基调】\n[Grid 1] {角色:楚长生} 走入 {场景:阎王殿}","video_prompts":"镜头1 时长15秒 {角色:楚长生}站定"}]';
		expect(() => JSON.parse(dirty)).toThrow(); // 证明严格 JSON 确实失败
		const cards = parseInferCards(dirty);
		expect(cards.length).toBe(1);
		expect(cards[0].title).toBe("第1卡");
		expect(cards[0].script).toContain("抬头看天");
		expect(cards[0].storyboardPrompt).toContain("{场景:阎王殿}");
		expect(cards[0].videoPrompt).toContain("站定");
	});

	it("容错：台词公式的未转义半角双引号（JSON.parse 会失败）", () => {
		const dirty =
			'[{"card_number":"第1卡","original_script":"x","storyboard_prompts":"s","video_prompts":"{音频:林小翠}的音色用[怒]:"你给我站住！" 镜头推进"}]';
		expect(() => JSON.parse(dirty)).toThrow();
		const cards = parseInferCards(dirty);
		expect(cards.length).toBe(1);
		expect(cards[0].videoPrompt).toContain("站住");
		expect(cards[0].videoPrompt).toContain("镜头推进");
	});

	it("流式：未闭合的尾卡也产出部分字段（边出边填）", () => {
		// 第1卡完整闭合，第2卡只到 original_script、值还没写完（无闭合引号）
		const partial =
			'[{"card_number":"第1卡","original_script":"完整内容","storyboard_prompts":"sb1","video_prompts":"vp1"},' +
			'{"card_number":"第2卡","original_script":"正在流式输出的原文';
		const cards = parseInferCardsStream(partial);
		expect(cards.length).toBe(2);
		expect(cards[0].videoPrompt).toBe("vp1");
		expect(cards[1].title).toBe("第2卡");
		expect(cards[1].script).toContain("正在流式输出");
		expect(cards[1].storyboardPrompt).toBe(""); // 尚未出现 → 留空
	});

	it("流式：只出现 card_number 也建卡（出现第n卡→新建行）", () => {
		const partial = '[{"card_number":"第1卡","original_script":"a","storyboard_prompts":"b","video_prompts":"c"},{"card_number":"第2卡","';
		const cards = extractCardsLoose(partial);
		expect(cards.length).toBe(2);
		expect(cards[1].title).toBe("第2卡");
		expect(cards[1].script).toBe("");
	});

	it("duration 字段：裸数字 / 带引号字符串（'3.0秒'）都解析成秒数，缺失=undefined", () => {
		// 严格 JSON：数字与字符串两种形态
		const json = JSON.stringify([
			{ card_number: "第1卡", duration: 3, original_script: "a", storyboard_prompts: "s", video_prompts: "v" },
			{ card_number: "第2卡", duration: "7.5秒", original_script: "b", storyboard_prompts: "s", video_prompts: "v" },
			{ card_number: "第3卡", original_script: "c", storyboard_prompts: "s", video_prompts: "v" },
		]);
		const cards = parseInferCards(json);
		expect(cards.map((c) => c.duration)).toEqual([3, 7.5, undefined]);
	});

	it("duration 容错抽取：JSON 非法（裸换行）时裸数字 duration 也能抽出；流式尾卡先出 duration 后出原文", () => {
		const dirty =
			'[{"card_number":"第1卡","duration": 2.2,"original_script":"楚长生走入\n大殿","storyboard_prompts":"s","video_prompts":"v"},' +
			'{"card_number":"第2卡","duration": 5';
		expect(() => JSON.parse(dirty)).toThrow();
		const cards = parseInferCardsStream(dirty);
		expect(cards.length).toBe(2);
		expect(cards[0].duration).toBe(2.2);
		expect(cards[0].script).toContain("大殿");
		expect(cards[1].duration).toBe(5); // 尾卡未闭合也先抽出时长
	});

	it("图视同源：unified_prompt 键解析为 unifiedPrompt，dual 字段为空", () => {
		const json = JSON.stringify([
			{ card_number: "第1卡", duration: 15, original_script: "陆沉霄暴退", unified_prompt: "【基调】…同源提示词A" },
		]);
		const cards = parseInferCards(json);
		expect(cards.length).toBe(1);
		expect(cards[0].unifiedPrompt).toBe("【基调】…同源提示词A");
		expect(cards[0].storyboardPrompt).toBe("");
		expect(cards[0].videoPrompt).toBe("");
		expect(cards[0].duration).toBe(15);
	});

	it("图视同源：别名 prompt 也归到 unifiedPrompt；容错抽取（非法 JSON）同样命中", () => {
		// 别名 prompt（严格 JSON）
		expect(parseInferCards('[{"card_number":"第1卡","original_script":"a","prompt":"同源B"}]')[0].unifiedPrompt).toBe("同源B");
		// 容错抽取：裸换行破坏整体 JSON，unified_prompt 仍抽出
		const dirty = '[{"card_number":"第1卡","original_script":"走入\n大殿","unified_prompt":"含换行的\n同源提示词';
		const cards = parseInferCardsStream(dirty);
		expect(cards[0].unifiedPrompt).toContain("同源提示词");
	});
});
