import { describe, it, expect } from "vitest";
import { aspectFromName, assetImageAspectFrom } from "./templateAspect";

describe("aspectFromName", () => {
    it("识别半角冒号比例标记", () => {
        expect(aspectFromName("资产拆分9:16")).toBe("9:16");
        expect(aspectFromName("推理模板 16:9 电影感")).toBe("16:9");
        expect(aspectFromName("方形1:1出图")).toBe("1:1");
    });

    it("识别全角冒号与空格间隔", () => {
        expect(aspectFromName("资产拆分9：16")).toBe("9:16");
        expect(aspectFromName("推理 16 : 9 版")).toBe("16:9");
        expect(aspectFromName("同源 9 ： 16")).toBe("9:16");
    });

    it("前导零归一（09:16 视为 9:16）", () => {
        expect(aspectFromName("竖屏09:16")).toBe("9:16");
    });

    it("无标记 / 空值 → null", () => {
        expect(aspectFromName("官方3")).toBeNull();
        expect(aspectFromName("普通模板")).toBeNull();
        expect(aspectFromName("")).toBeNull();
        expect(aspectFromName(undefined)).toBeNull();
        expect(aspectFromName(null)).toBeNull();
    });

    it("应用不支持的比例不误吞（21:9 / 4:3 / 1:10）→ null", () => {
        expect(aspectFromName("电影感21:9")).toBeNull();
        expect(aspectFromName("老式4:3")).toBeNull();
        expect(aspectFromName("编号1:10")).toBeNull();
    });

    it("多个标记取第一个可识别的", () => {
        expect(aspectFromName("9:16改16:9")).toBe("9:16");
        expect(aspectFromName("21:9备用9:16")).toBe("9:16"); // 第一个不认识，继续扫
    });
});

describe("assetImageAspectFrom（资产出图比例决定链）", () => {
    const tpls = [
        { id: "t-def", name: "资产提取·白羊", purpose: "script.analyze", isDefault: true },
        { id: "t-916", name: "资产拆分9:16", purpose: "script.analyze" },
        { id: "t-ep", name: "剧集9:16", purpose: "script.analyze", category: "内部" },
        { id: "t-other", name: "其他用途16:9", purpose: "storyboard.split" },
    ];

    it("选中带比例模板 → 模板比例优先", () => {
        expect(assetImageAspectFrom(tpls, "t-916", "16:9")).toBe("9:16");
    });

    it("选中无比例模板 → 项目默认比例", () => {
        expect(assetImageAspectFrom(tpls, "t-def", "9:16")).toBe("9:16");
        expect(assetImageAspectFrom(tpls, "t-def", "1:1")).toBe("1:1");
    });

    it("未选中（空）→ 解析默认款（isDefault）的名称", () => {
        expect(assetImageAspectFrom(tpls, undefined, "16:9")).toBe("16:9"); // 默认款无标记 → 项目默认
        const tpls2 = [{ id: "d", name: "资产拆分9:16", purpose: "script.analyze", isDefault: true }];
        expect(assetImageAspectFrom(tpls2, undefined, "16:9")).toBe("9:16"); // 默认款带标记 → 模板比例
    });

    it("选中 id 已失效 → 回落默认款链条", () => {
        expect(assetImageAspectFrom(tpls, "gone", "16:9")).toBe("16:9");
    });

    it("「内部」分类与其它 purpose 不参与；catalog 未到货回落项目默认 / 16:9", () => {
        expect(assetImageAspectFrom(tpls, "t-ep", "16:9")).toBe("16:9"); // 内部模板不认
        expect(assetImageAspectFrom(undefined, undefined, "9:16")).toBe("9:16");
        expect(assetImageAspectFrom(undefined, undefined, undefined)).toBe("16:9");
    });
});
