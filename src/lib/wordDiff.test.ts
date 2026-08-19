import { describe, it, expect } from "vitest";
import { computeChangedFlags } from "./wordDiff";

/** 把高亮结果可视化：更改字符用 [x] 包裹，便于断言 */
function marked(text: string, base: string): string {
    const f = computeChangedFlags(text, base);
    if (!f) return text;
    let out = "";
    for (let i = 0; i < text.length; i++) out += f[i] ? `[${text[i]}]` : text[i];
    return out;
}

describe("wordDiff.computeChangedFlags", () => {
    it("CJK 按字 LCS：仅高亮确认新增的字，删了又填回同样的字不高亮（用户给的例子）", () => {
        // 「此处的左边有更改」→「此处的最右边没有更改」：只「最右」「没」是新增
        expect(marked("此处的最右边没有更改", "此处的左边有更改")).toBe("此处的[最][右]边[没]有更改");
    });

    it("单字替换只高亮被换掉的字", () => {
        expect(marked("一只黑色的猫", "一只白色的猫")).toBe("一只[黑]色的猫");
    });

    it("拉丁文按词：仅高亮新增的整词", () => {
        expect(marked("hello brave new world", "hello new world")).toBe("hello [b][r][a][v][e] new world");
    });

    it("无更改 → 无高亮", () => {
        expect(marked("张起灵走入大殿", "张起灵走入大殿")).toBe("张起灵走入大殿");
    });

    it("空文本 / 空基线", () => {
        expect(computeChangedFlags("", "base")).toBeUndefined();
        // 基线为空 = 全文皆新增
        expect(computeChangedFlags("abc", "")).toEqual([true, true, true]);
    });

    it("@tag 作为原子 token：换了引用才高亮", () => {
        // 同样的 @Image1 不高亮，新增的 @Image2 高亮
        const f = computeChangedFlags("看 @Image1 和 @Image2", "看 @Image1")!;
        // "@Image2" 整体应被标记
        const idx = "看 @Image1 和 @Image2".indexOf("@Image2");
        expect(f[idx]).toBe(true);
        expect(f["看 @Image1 和 @Image2".indexOf("@Image1")]).toBe(false);
    });
});
