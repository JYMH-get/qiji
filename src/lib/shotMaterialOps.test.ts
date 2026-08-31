import { describe, it, expect, beforeEach } from "vitest";
import { useProjectStore } from "@/store/projectStore";
import type { ShotMaterial, StoryboardShot } from "@/services/projectFile";
import { buildLegend } from "@/lib/shotMaterials";
import { reorderShotMaterial, removeShotMaterial, addShotMaterialFromAsset, resyncShotLegend } from "@/lib/shotMaterialOps";

/**
 * 分镜素材增删/重排的图例一致性（「(孟金珠) 是 贺长安」错位事故的回归锁）：
 * 任何改动素材集合/顺序的路径都必须让 图例前缀 + 正文内联 @ 引用 跟随素材区编号。
 */
const mat = (id: string, name: string, uri = `asset://${id}.png`, extra?: Partial<ShotMaterial>): ShotMaterial =>
    ({ id, assetId: `ent-${id}`, kind: "character", media: "image", name, uri, ...extra } as ShotMaterial);

const seed = (shot: Partial<StoryboardShot>, mediaSettings: Record<string, unknown> = {}) => {
    useProjectStore.setState({
        mediaSettings,
        episodes: [{
            id: "ep1", title: "第一集", scriptText: "",
            shots: [{ id: "sh1", index: 1, title: "分镜1", scriptSegment: "", prompt: "", materials: [], ...shot }],
        }],
    } as any);
};

const shot = () => useProjectStore.getState().episodes[0].shots[0];

describe("reorderShotMaterial — 重排后图例整体重建 + 正文 @ 引用重映射", () => {
    beforeEach(() => {
        const mats = [mat("ma", "甲"), mat("mb", "乙"), mat("mc", "丙")];
        seed({
            materials: mats,
            videoPrompt: `${buildLegend(mats, false)}\n\n镜头推近 @Image3 与 @Image1`,
            storyboardPrompt: `${buildLegend(mats, true)}\n\n构图以 @Image3 为主体`,
        });
    });

    it("把末位素材拖到首位：素材序/图例/正文编号三者一致", () => {
        reorderShotMaterial("ep1", "sh1", "mc", "ma"); // 丙 拖到 甲 前
        const s = shot();
        expect(s.materials.map((m) => m.name)).toEqual(["丙", "甲", "乙"]);
        // 图例按新素材序整体重建（截图事故形态：图例名字与素材位错开一位——此处锁死不再发生）
        expect(s.videoPrompt).toContain("【素材图例】@Image1 是 丙；@Image2 是 甲；@Image3 是 乙；");
        // 正文内联引用跟随：丙 @Image3→@Image1、甲 @Image1→@Image2
        expect(s.videoPrompt).toContain("镜头推近 @Image1 与 @Image2");
        expect(s.storyboardPrompt).toContain("【素材图例】@Image1 是 丙；@Image2 是 甲；@Image3 是 乙；");
        expect(s.storyboardPrompt).toContain("构图以 @Image1 为主体");
    });

    it("重排幂等安全：fromId 不存在/相同 id 不动数据", () => {
        const before = shot();
        reorderShotMaterial("ep1", "sh1", "mx", "ma");
        reorderShotMaterial("ep1", "sh1", "ma", "ma");
        expect(shot()).toEqual(before);
    });

    it("图视同源：重排把图例重建进 unifiedPrompt、正文引用同步重映射", () => {
        const mats = [mat("ma", "甲"), mat("mb", "乙")];
        seed({ materials: mats, unifiedPrompt: `${buildLegend(mats, false)}\n\n@Image2 出场` }, { imgVideoSameSource: true });
        reorderShotMaterial("ep1", "sh1", "mb", "ma"); // 乙 拖到 甲 前
        const s = shot();
        expect(s.materials.map((m) => m.name)).toEqual(["乙", "甲"]);
        expect(s.unifiedPrompt).toContain("【素材图例】@Image1 是 乙；@Image2 是 甲；");
        expect(s.unifiedPrompt).toContain("@Image1 出场");
    });
});

describe("removeShotMaterial / addShotMaterialFromAsset — 表格页增删收口语义", () => {
	it("再次拖入资产只新增缺失说明，不还原用户改名或清空同行正文", () => {
		const mats = [mat("ma", "三娘")];
		seed({ materials: mats, videoPrompt: "【素材图例】@Image1 是 赵三娘，赵三娘和李四在吃饭" });
		addShotMaterialFromAsset("ep1", "sh1", {
			assetId: "ent-mb", uri: "asset://mb.png", name: "李四", media: "image", kind: "character",
		});
		expect(shot().videoPrompt).toBe(
			"【素材图例】@Image1 是 赵三娘；@Image2 是 李四；\n\n赵三娘和李四在吃饭",
		);
	});

    it("删中间素材：图例重建无残句、正文编号前移", () => {
        const mats = [mat("ma", "甲"), mat("mb", "乙"), mat("mc", "丙")];
        seed({ materials: mats, videoPrompt: `${buildLegend(mats, false)}\n\n@Image3 说话` });
        removeShotMaterial("ep1", "sh1", "mb");
        const s = shot();
        expect(s.materials.map((m) => m.name)).toEqual(["甲", "丙"]);
        expect(s.videoPrompt).toContain("【素材图例】@Image1 是 甲；@Image2 是 丙；");
        expect(s.videoPrompt).not.toContain("是 乙");
        expect(s.videoPrompt).toContain("@Image2 说话");
    });

    it("添加保留 kind/voiceForAssetId（跨分镜复制随行），并同步补图例；同 assetId 去重", () => {
        const mats = [mat("ma", "甲")];
        seed({ materials: mats, videoPrompt: `${buildLegend(mats, false)}\n\n正文` });
        addShotMaterialFromAsset("ep1", "sh1", { assetId: "ent-vc", uri: "asset://vc.mp3", name: "甲的声音", media: "audio", kind: "local", voiceForAssetId: "ent-ma" });
        let s = shot();
        expect(s.materials).toHaveLength(2);
        expect(s.materials[1]).toMatchObject({ kind: "local", media: "audio", voiceForAssetId: "ent-ma" });
        // 音频与角色图配对进图例
        expect(s.videoPrompt).toContain("@Image1的声音参考@Audio1");
        // 去重：同 assetId 不重复加入
        addShotMaterialFromAsset("ep1", "sh1", { assetId: "ent-vc", uri: "asset://vc-other.mp3", name: "重复", media: "audio" });
        s = shot();
        expect(s.materials).toHaveLength(2);
    });

    it("resyncShotLegend：调用方已写入素材（如上传占位）后按当前素材刷新图例", () => {
        const mats = [mat("ma", "甲"), mat("up1", "上传中", "")];
        seed({ materials: mats, videoPrompt: "正文" });
        resyncShotLegend("ep1", "sh1");
        // 占位素材（uri 空）同样占 @ 编号 → 图例如实给号（提交层对空 uri 明确报错，不静默丢）
        expect(shot().videoPrompt).toContain("【素材图例】@Image1 是 甲；@Image2 是 上传中；");
    });
});
