import { describe, expect, it } from "vitest";
import type { ShotMaterial } from "@/services/projectFile";
import { MENTION_TAG_RE, buildLegend, materialTags, tagToMaterial, stripLegend, applyLegend, remapBodyTags } from "@/lib/shotMaterials";

const mat = (id: string, name: string, media?: ShotMaterial["media"]): ShotMaterial =>
    ({ id, name, uri: "", media } as ShotMaterial);

describe("materialTags — 同模态分组内 1-based 编号（与上游数组顺序对齐）", () => {
    it("图像/视频/音频各自从 1 起编号", () => {
        const mats = [
            mat("a", "张起灵"),                 // image (默认)
            mat("b", "片头曲", "audio"),
            mat("c", "张起天", "image"),
            mat("d", "运镜参考", "video"),
            mat("e", "环境音", "audio"),
        ];
        expect(materialTags(mats)).toEqual({
            a: "@Image1",
            b: "@Audio1",
            c: "@Image2",
            d: "@Video1",
            e: "@Audio2",
        });
    });

    it("tagToMaterial 反查：@Image1 → 对应素材", () => {
        const mats = [mat("a", "张起灵"), mat("c", "张起天", "image")];
        const map = tagToMaterial(mats);
        expect(map.get("@Image1")?.name).toBe("张起灵");
        expect(map.get("@Image2")?.name).toBe("张起天");
        expect(map.get("@Image3")).toBeUndefined();
    });
});

describe("buildLegend — 角色声音参考配对（音频不产「是」条目，只留配对）", () => {
    it("视频图例：音频不出「@AudioN 是 xxx」，只有「@ImageN的声音参考@AudioM」（音频带 voiceForAssetId 指向角色）", () => {
        const mats: ShotMaterial[] = [
            { id: "img", assetId: "C01", kind: "character", name: "楚长生", uri: "", media: "image" },
            { id: "aud", assetId: "audio1", kind: "local", name: "楚长生的声音", uri: "", media: "audio", voiceForAssetId: "C01" },
        ];
        expect(buildLegend(mats, false)).toBe("【素材图例】@Image1 是 楚长生，@Image1的声音参考@Audio1，");
    });
    it("故事板图例（imagesOnly）不含音频与声音参考", () => {
        const mats: ShotMaterial[] = [
            { id: "img", assetId: "C01", kind: "character", name: "楚长生", uri: "", media: "image" },
            { id: "aud", assetId: "audio1", kind: "local", name: "楚长生的声音", uri: "", media: "audio", voiceForAssetId: "C01" },
        ];
        expect(buildLegend(mats, true)).toBe("【素材图例】@Image1 是 楚长生，");
    });
    it("音频无对应角色图像时不产生任何图例条目（图例为空）", () => {
        const mats: ShotMaterial[] = [
            { id: "aud", assetId: "audio1", kind: "local", name: "环境音", uri: "", media: "audio", voiceForAssetId: "C99" },
        ];
        expect(buildLegend(mats, false)).toBe("");
    });
    it("视频素材仍产「@VideoN 是 xxx」条目（「是」格式限图像/视频）", () => {
        const mats: ShotMaterial[] = [
            { id: "img", assetId: "C01", kind: "character", name: "楚长生", uri: "", media: "image" },
            { id: "vid", assetId: "video1", kind: "local", name: "运镜参考", uri: "", media: "video" },
        ];
        expect(buildLegend(mats, false)).toBe("【素材图例】@Image1 是 楚长生，@Video1 是 运镜参考，");
    });
});

describe("stripLegend / applyLegend — 素材增删同步图例（删不留残句）", () => {
    it("stripLegend 剥掉图例块保留正文", () => {
        expect(stripLegend("【素材图例】@Image1 是 张三，\n\n正文在这")).toBe("正文在这");
        expect(stripLegend("没有图例的正文")).toBe("没有图例的正文");
    });
    it("删除素材：按新素材整体重建图例，旧「@X 是 xxx」不残留，正文 @ 引用重编号", () => {
        const prompt = "【素材图例】@Image1 是 张三，@Image2 是 李四，\n\n镜头推近 @Image2 说话";
        // 删了张三(@Image1)，剩李四；新图例由 buildLegend([李四]) 得到
        const newLegend = buildLegend([mat("b", "李四", "image")], false);
        const out = applyLegend(prompt, newLegend, { media: "image", n: 1 });
        expect(out).toBe("【素材图例】@Image1 是 李四，\n\n镜头推近 @Image1 说话");
        expect(out).not.toContain("张三");
    });
    it("删除声音素材：图例里「@ImageN的声音参考@AudioM」整体重建、无残留", () => {
        const prompt = "【素材图例】@Image1 是 楚长生，@Image1的声音参考@Audio1，\n\n@Image1 开口";
        // 删了声音(@Audio1)，剩角色图；新图例只剩「@Image1 是 楚长生，」
        const newLegend = buildLegend([{ id: "img", assetId: "C01", kind: "character", name: "楚长生", uri: "", media: "image" }], false);
        const out = applyLegend(prompt, newLegend, { media: "audio", n: 1 });
        expect(out).toBe("【素材图例】@Image1 是 楚长生，\n\n@Image1 开口");
        expect(out).not.toContain("声音参考");
    });
    it("添加素材（无 removed）：剥旧图例前置新图例、正文不动", () => {
        const prompt = "【素材图例】@Image1 是 张三，\n\n@Image1 登场";
        const newLegend = buildLegend([mat("a", "张三", "image"), mat("c", "李四", "image")], false);
        expect(applyLegend(prompt, newLegend)).toBe("【素材图例】@Image1 是 张三，@Image2 是 李四，\n\n@Image1 登场");
    });
});

describe("remapBodyTags — 素材重排后正文内联 @ 引用按新旧编号置换", () => {
    it("交换类映射不串连改写（单次扫描，置换结果不被二次匹配）", () => {
        expect(remapBodyTags("@Image1 与 @Image2 同框", { "@Image1": "@Image2", "@Image2": "@Image1" }))
            .toBe("@Image2 与 @Image1 同框");
    });
    it("链式映射各自独立置换（@1→@2、@2→@3 不变成 @1→@3）", () => {
        expect(remapBodyTags("@Image1 @Image2", { "@Image1": "@Image2", "@Image2": "@Image3" }))
            .toBe("@Image2 @Image3");
    });
    it("映射外的 tag 原样保留；两位数编号不被前缀误匹配", () => {
        expect(remapBodyTags("@Image12 跟着 @Video1", { "@Image1": "@Image9" }))
            .toBe("@Image12 跟着 @Video1");
    });
    it("空映射/空文本原样返回", () => {
        expect(remapBodyTags("@Image1", {})).toBe("@Image1");
        expect(remapBodyTags("", { "@Image1": "@Image2" })).toBe("");
    });
});

describe("MENTION_TAG_RE — 提示词里抽 @tag", () => {
    it("抓全 @Image/@Video/@Audio + 数字，含两位数", () => {
        const text = "镜头 {角色:张起灵} @Image1 走入 @Video2，背景 @Audio10 与 @Image12。";
        const found = text.match(new RegExp(MENTION_TAG_RE.source, "g"));
        expect(found).toEqual(["@Image1", "@Video2", "@Audio10", "@Image12"]);
    });
});
