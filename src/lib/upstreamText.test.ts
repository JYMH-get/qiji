import { describe, it, expect } from "vitest";
import {
	upstreamTag,
	hasUpstreamCapsule,
	stripUpstreamCapsules,
	buildUpstreamCapsuleBlock,
	setUpstreamCapsules,
	expandUpstreamCapsules,
} from "@/lib/upstreamText";

describe("upstreamText（逐个编号胶囊）", () => {
	it("upstreamTag / hasUpstreamCapsule", () => {
		expect(upstreamTag(2)).toBe("【上游文本2】");
		expect(hasUpstreamCapsule("前 【上游文本1】 后")).toBe(true);
		expect(hasUpstreamCapsule("没有胶囊")).toBe(false);
	});

	it("buildUpstreamCapsuleBlock 拼 1..n 各占一行；n<=0 为空", () => {
		expect(buildUpstreamCapsuleBlock(3)).toBe("【上游文本1】\n【上游文本2】\n【上游文本3】");
		expect(buildUpstreamCapsuleBlock(0)).toBe("");
	});

	it("setUpstreamCapsules 幂等重置为恰好 1..n（含正文时前置）", () => {
		expect(setUpstreamCapsules("", 2)).toBe("【上游文本1】\n【上游文本2】");
		expect(setUpstreamCapsules("用户正文", 1)).toBe("【上游文本1】\n用户正文");
		// 数量变化：已有 1 枚 → 需要 2 枚
		expect(setUpstreamCapsules("【上游文本1】", 2)).toBe("【上游文本1】\n【上游文本2】");
		// 已恰好 → 不变
		expect(setUpstreamCapsules("【上游文本1】\n【上游文本2】", 2)).toBe("【上游文本1】\n【上游文本2】");
		// n=0 → 仅剥离
		expect(setUpstreamCapsules("【上游文本1】\n正文", 0)).toBe("正文");
	});

	it("stripUpstreamCapsules 剥掉所有胶囊连同紧邻换行", () => {
		expect(stripUpstreamCapsules("【上游文本1】\n【上游文本2】\n正文")).toBe("正文");
		expect(stripUpstreamCapsules("无胶囊")).toBe("无胶囊");
	});

	it("expandUpstreamCapsules 按编号还原为对应上游文本（越界→空）", () => {
		expect(expandUpstreamCapsules("【上游文本1】\n【上游文本2】", ["甲", "乙"])).toBe("甲\n乙");
		// 编号 2 越界 → 空串
		expect(expandUpstreamCapsules("【上游文本1】\n【上游文本2】", ["只有一个"])).toBe("只有一个\n");
	});

	it("expandUpstreamCapsules 用函数式替换：上游文本含 $ 不被当替换模式", () => {
		expect(expandUpstreamCapsules("【上游文本1】", ["价格$5与$&符号"])).toBe("价格$5与$&符号");
	});

	it("无胶囊时 expand 原样返回", () => {
		expect(expandUpstreamCapsules("普通提示词", ["上游"])).toBe("普通提示词");
	});
});
