import { describe, it, expect } from "vitest";
import { checkMaterialLimits } from "./materialLimits";

// 第145轮：素材数量预检（与服务端 server/src/materialLimits.ts 同尺）——判定语义锁定

describe("checkMaterialLimits", () => {
	it("未设上限（undefined）= 不限，任何数量放行", () => {
		expect(checkMaterialLimits("hy933", undefined, { images: new Array(99), videos: new Array(99) })).toBeNull();
	});

	it("0 = 不允许该类素材：933 收紧为 903（vid:0）时带视频被明确拒绝", () => {
		const err = checkMaterialLimits("hy933", { img: 9, vid: 0, aud: 3 }, { images: [1], videos: [1] });
		expect(err).toContain("不支持视频素材");
		expect(err).toContain("hy933");
		expect(err).toContain("1 个");
	});

	it("恰好等于上限放行、超一个即拒（带数量与类型）", () => {
		const lim = { img: 2 };
		expect(checkMaterialLimits("m", lim, { images: [1, 2] })).toBeNull();
		const err = checkMaterialLimits("m", lim, { images: [1, 2, 3] });
		expect(err).toContain("最多支持 2 个图片素材");
		expect(err).toContain("3 个");
	});

	it("未声明的键不限：只限视频时图片/音频不受影响", () => {
		expect(checkMaterialLimits("m", { vid: 0 }, { images: new Array(9), audios: new Array(5) })).toBeNull();
	});

	it("inputs 缺省/为空按 0 计，恒放行", () => {
		expect(checkMaterialLimits("m", { img: 0, vid: 0, aud: 0 }, undefined)).toBeNull();
		expect(checkMaterialLimits("m", { img: 0, vid: 0, aud: 0 }, {})).toBeNull();
	});
});
