import { describe, it, expect } from "vitest";
import { buildLegend } from "@/lib/shotMaterials";
import {
	upstreamTag,
	hasUpstreamCapsule,
	stripUpstreamCapsules,
	buildUpstreamCapsuleBlock,
	setUpstreamCapsules,
	expandUpstreamCapsules,
	mapUpstreamText,
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

	it("无自有正文时直接映射上游全文", () => {
		expect(mapUpstreamText("", ["分镜原文", "追加说明"])).toBe("分镜原文\n\n追加说明");
	});

	it("上游全文映射在图例和前置预设之后", () => {
		expect(mapUpstreamText("【素材图例】@Image1 是 赵云；\n\n【预设:preset.pfx】", ["骑马入城"])).toBe(
			"【素材图例】@Image1 是 赵云；\n\n【预设:preset.pfx】\n骑马入城",
		);
	});

	it("目标节点已有自有正文时不自动混入上游", () => {
		expect(mapUpstreamText("用户改写", ["上游原文"])).toBe("用户改写");
	});

	it("旧项目的上游胶囊在原位兼容展开", () => {
		expect(mapUpstreamText("前缀\n【上游文本1】\n后缀", ["旧链路原文"])).toBe("前缀\n旧链路原文\n后缀");
	});

	it("节点六图图例承接带七图旧图例的上游时，只采用当前节点图例", () => {
		const materials = ["刘备", "曹操", "孙权", "赵云", "典韦", "甘宁"].map((name, i) => ({ id: String(i), name, uri: "", media: "image" as const, kind: "local" as const }));
		const current = buildLegend(materials, true).replace("刘备；", "刘备，身穿战甲；");
		const old = buildLegend([...materials, { id: "scene", name: "镇魂宗外", uri: "", media: "image", kind: "local" }], true);
		const source = `${old}\n\n刘备持剑，曹操站在旁边。`;
		const expected = `${current}\n\n刘备持剑，曹操站在旁边。`;
		expect(mapUpstreamText(current, [source])).toBe(expected);
		expect(mapUpstreamText(expected, [source])).toBe(expected);
		expect(mapUpstreamText(`${current}\n\n【上游文本1】`, [source])).toBe(expected);
	});

	it("没有节点自有图例时仍保留上游图例，避免丢掉唯一素材说明", () => {
		const source = "【素材图例】@Image1 是 刘备；\n\n刘备持剑。";
		expect(mapUpstreamText("", [source])).toBe(source);
	});

	it("已有正文的单段图例保持原来的标点与换行", () => {
		const prompt = "【素材图例】@Image1 是 刘备，\n刘备持剑。";
		expect(mapUpstreamText(prompt, ["上游正文"])).toBe(prompt);
		expect(mapUpstreamText(prompt, [])).toBe(prompt);
	});
});
