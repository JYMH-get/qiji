/**
 * flowCore 单测 —— 「AI 生成」分步工作台纯逻辑：
 * 剧本摘要 / 分集概览（覆盖确认判定）/ 资产拆分模板变量（查重清单格式与续提并入群像）。
 */
import { describe, it, expect } from "vitest";
import {
	codeFromId, fmtAssetList, nowVariable, buildExtractVariables,
	scriptBrief, episodesBrief, splitOverwriteMessage,
} from "./flowCore";

describe("flowCore.codeFromId / fmtAssetList", () => {
	it("从资产 id 回收编号前缀", () => {
		expect(codeFromId("C01-1723456789-3")).toBe("C01");
		expect(codeFromId("S12A-99-1")).toBe("S12A");
		expect(codeFromId("无编号")).toBe("");
	});

	it("查重清单：编号+名称+变体标签；空数组回退占位文案", () => {
		expect(fmtAssetList([], "无角色数据")).toBe("无角色数据");
		expect(fmtAssetList(undefined, "无场景数据")).toBe("无场景数据");
		const line = fmtAssetList([
			{ id: "C01-1-1", name: "李昂", variants: [{ label: "战损" }, { name: "夜行装" }] },
			{ id: "C02-1-2", name: "苏檀" },
		], "无角色数据");
		expect(line).toBe("C01 李昂（变体: 战损 / 夜行装）、C02 苏檀");
	});
});

describe("flowCore.buildExtractVariables", () => {
	const base = {
		scriptText: "第一集 山门夜雨",
		visualStyle: "国漫电影感",
		characters: [{ id: "C01-1-1", name: "李昂" }],
		scenes: [{ id: "S01-1-2", name: "山门" }],
		items: [],
		organisms: [],
		crowds: [{ id: "G01-1-3", name: "巡山队" }],
	};

	it("首提：角色列表只含角色（群像不并入），空类回退占位", () => {
		const v = buildExtractVariables({ ...base, now: new Date(2026, 7, 17, 9, 5, 3) });
		expect(v.原文).toBe("第一集 山门夜雨");
		expect(v.视觉风格).toBe("国漫电影感");
		expect(v.角色列表).toBe("C01 李昂");
		expect(v.场景列表).toBe("S01 山门");
		expect(v.物品列表).toBe("无物品/道具数据");
		expect(v.生物列表).toBe("无生物数据");
		expect(v.当前时间).toBe("2026/08/17 09:05:03");
	});

	it("续提（continueMode）：群像并入角色列表（与 Frame1693 handleContinueExtraction 同构）", () => {
		const v = buildExtractVariables({ ...base, continueMode: true });
		expect(v.角色列表).toBe("C01 李昂、G01 巡山队");
	});

	it("nowVariable 补零格式稳定", () => {
		expect(nowVariable(new Date(2025, 0, 2, 3, 4, 5))).toBe("2025/01/02 03:04:05");
	});
});

describe("flowCore.scriptBrief", () => {
	it("空剧本：empty=true 零字数", () => {
		expect(scriptBrief("")).toEqual({ chars: 0, preview: "", empty: true });
		expect(scriptBrief("   \n  ")).toEqual({ chars: 0, preview: "", empty: true });
	});

	it("取前几个非空行合并预览，字数按去首尾空白计", () => {
		const b = scriptBrief("第一集\n\n夜雨滂沱。\n第二段不该出现在预览", 2);
		expect(b.empty).toBe(false);
		expect(b.preview).toBe("第一集 / 夜雨滂沱。");
		expect(b.chars).toBe("第一集\n\n夜雨滂沱。\n第二段不该出现在预览".length);
	});

	it("超长预览截断加省略号", () => {
		const b = scriptBrief(`${"很".repeat(100)}\n第二行`, 2, 20);
		expect(b.preview.endsWith("…")).toBe(true);
		expect(b.preview.length).toBe(21); // 20 字 + 省略号
	});
});

describe("flowCore.episodesBrief / splitOverwriteMessage", () => {
	it("新项目单个空默认分集：不算已有成果（不触发覆盖确认）", () => {
		const b = episodesBrief([{ scriptText: "", shots: [] }]);
		expect(b).toEqual({ count: 1, shotCount: 0, hasContent: false });
	});

	it("多集 / 单集带正文或分镜：算已有成果", () => {
		expect(episodesBrief([{ scriptText: "", shots: [] }, { scriptText: "", shots: [] }]).hasContent).toBe(true);
		expect(episodesBrief([{ scriptText: "正文", shots: [] }]).hasContent).toBe(true);
		expect(episodesBrief([{ scriptText: "", shots: [{} as any] }]).hasContent).toBe(true);
	});

	it("分镜计数跨集累加；覆盖确认文案含集数与分镜数", () => {
		const b = episodesBrief([
			{ scriptText: "a", shots: [{} as any, {} as any] },
			{ scriptText: "b", shots: [{} as any] },
		]);
		expect(b.shotCount).toBe(3);
		const msg = splitOverwriteMessage(b);
		expect(msg).toContain("2 集");
		expect(msg).toContain("3 个分镜");
		// 无分镜时不提分镜
		expect(splitOverwriteMessage({ count: 2, shotCount: 0, hasContent: true })).not.toContain("分镜");
	});
});
