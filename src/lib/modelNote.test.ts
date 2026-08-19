import { describe, expect, it } from "vitest";
import { modelNoteText } from "./modelNote";

describe("modelNoteText（模型备注：管理端 note 优先，未设按 matLimits 派生默认文案）", () => {
	it("管理端备注优先（trim 后返回）", () => {
		expect(modelNoteText({ note: "  仅支持动漫风格素材  ", matLimits: { img: 9 } })).toBe("仅支持动漫风格素材");
	});

	it("备注为空白=未设，回落 matLimits 默认文案", () => {
		expect(modelNoteText({ note: "   ", matLimits: { img: 9, vid: 3, aud: 3 } })).toBe(
			"参考素材上限：图 9 · 视频 3 · 音频 3",
		);
	});

	it("matLimits 键缺省=不限、0=不支持", () => {
		expect(modelNoteText({ matLimits: { img: 9, vid: 0 } })).toBe("参考素材上限：图 9 · 视频 不支持 · 音频 不限");
	});

	it("无 matLimits（或空对象）=不限（按模型能力）", () => {
		expect(modelNoteText({})).toBe("参考素材数量：不限（按模型能力）");
		expect(modelNoteText({ matLimits: {} })).toBe("参考素材数量：不限（按模型能力）");
	});

	it("无 catalog 模型（本地 CLI 渠道）返回空串=不显示提示", () => {
		expect(modelNoteText(undefined)).toBe("");
		expect(modelNoteText(null)).toBe("");
	});
});
