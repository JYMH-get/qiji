import { describe, it, expect } from "vitest";
import { buildH3Graph, toOfficialTags, type H3GraphOpts } from "@/lib/comfyH3Graph";
import { collectComfyRefs } from "@/services/adapters/comfyuiAdapter";

/** 按 class_type 找节点（测试侧不靠死 id，与实现同一约定） */
function nodesOfClass(graph: Record<string, any>, classType: string): any[] {
	return Object.values(graph).filter((n: any) => n?.class_type === classType);
}
function nodeOfClass(graph: Record<string, any>, classType: string): any {
	const arr = nodesOfClass(graph, classType);
	expect(arr.length).toBe(1);
	return arr[0];
}
function refNodeOf(graph: Record<string, any>): any {
	return nodeOfClass(graph, "MiniMaxH3ReferenceToVideo");
}

function base(over?: Partial<H3GraphOpts>): H3GraphOpts {
	return {
		workflow: "jianyi933",
		prompt: "测试提示词",
		seed: 42,
		images: [],
		videos: [],
		audios: [],
		...over,
	};
}

describe("comfyH3Graph buildH3Graph（与服务端 comfyGraph.ts 双拷贝同骨架）", () => {
	it("完整建图：ref 键 / loader 形状 / aspect+megapixels / seed / duration 全对", () => {
		const g = buildH3Graph(base({
			prompt: "两张图一段视频一段音频",
			seed: 12345,
			durationSec: 12,
			aspect: "9:16",
			resolution: "1080p",
			images: [{ file: "a.png" }, { file: "b.png" }],
			videos: [{ file: "v.mp4" }],
			audios: [{ file: "m.mp3", durationSec: 7.5 }],
		}));

		// 核心参数节点
		const res = nodeOfClass(g, "ResolutionSelector");
		expect(res.inputs.aspect_ratio).toBe("9:16 (Portrait Widescreen)"); // 枚举串逐字
		expect(res.inputs.megapixels).toBe(2); // 1080p → 2
		expect(nodeOfClass(g, "PrimitiveFloat").inputs.value).toBe(12);
		expect(nodeOfClass(g, "PrimitiveStringMultiline").inputs.value).toBe("两张图一段视频一段音频");
		expect(nodeOfClass(g, "RandomNoise").inputs.noise_seed).toBe(12345);

		// ref 键 → 动态素材节点（9001 起），编号 0 基与传入顺序一致
		const ref = refNodeOf(g);
		const img0 = ref.inputs["ref_images.ref_image_0"];
		const img1 = ref.inputs["ref_images.ref_image_1"];
		const vid0 = ref.inputs["ref_videos.ref_video_0"];
		const aud0 = ref.inputs["ref_audios.ref_audio_0"];
		for (const link of [img0, img1, vid0, aud0]) {
			expect(Array.isArray(link)).toBe(true);
			expect(Number(link[0])).toBeGreaterThanOrEqual(9001);
			expect(link[1]).toBe(0);
		}
		// loader 形状（字段值=用户在实例上调好的值）
		expect(g[img0[0]].class_type).toBe("LoadImage");
		expect(g[img0[0]].inputs.image).toBe("a.png");
		expect(g[img1[0]].inputs.image).toBe("b.png");
		expect(g[vid0[0]].class_type).toBe("VHS_LoadVideo");
		expect(g[vid0[0]].inputs).toMatchObject({ video: "v.mp4", force_rate: 8, frame_load_cap: 240, format: "AnimateDiff" });
		expect(g[aud0[0]].class_type).toBe("LoadAudioUI");
		expect(g[aud0[0]].inputs).toMatchObject({ audio: "m.mp3", start_time: 0, end_time: 7.5, duration: 7.5 });
	});

	it("零素材：零 loader 节点、136 节点零 ref_* 键（⚠ 骨架自带的 ref_image_size 配置键不受影响）", () => {
		const g = buildH3Graph(base());
		expect(nodesOfClass(g, "LoadImage").length).toBe(0);
		expect(nodesOfClass(g, "VHS_LoadVideo").length).toBe(0);
		expect(nodesOfClass(g, "LoadAudioUI").length).toBe(0);
		const ref = refNodeOf(g);
		// 断言用 /^ref_(images|videos|audios)\./ 前缀——别误伤骨架 136 自带的 ref_image_size
		expect(Object.keys(ref.inputs).filter((k) => /^ref_(images|videos|audios)\./.test(k))).toEqual([]);
		expect(ref.inputs.ref_image_size).toBe("max");
	});

	it("缺省参数保持骨架默认（时长 15 / 16:9 / 0.4mp），且不污染骨架常量（structuredClone）", () => {
		// 先带覆盖值建一次（若实现直接改骨架常量，这里会把默认值弄脏）
		buildH3Graph(base({ durationSec: 8, aspect: "1:1", resolution: "480p" }));
		const g = buildH3Graph(base());
		expect(nodeOfClass(g, "PrimitiveFloat").inputs.value).toBe(15);
		const res = nodeOfClass(g, "ResolutionSelector");
		expect(res.inputs.aspect_ratio).toBe("16:9 (Widescreen)");
		expect(res.inputs.megapixels).toBe(0.4);
	});

	it("八档比例 / 四档分辨率映射逐档正确", () => {
		const aspects: Record<string, string> = {
			"16:9": "16:9 (Widescreen)",
			"9:16": "9:16 (Portrait Widescreen)",
			"1:1": "1:1 (Square)",
			"4:3": "4:3 (Standard)",
			"3:4": "3:4 (Portrait Standard)",
			"2:3": "2:3 (Portrait Photo)",
			"3:2": "3:2 (Photo)",
			"21:9": "21:9 (Ultrawide)",
		};
		for (const [k, v] of Object.entries(aspects)) {
			expect(nodeOfClass(buildH3Graph(base({ aspect: k })), "ResolutionSelector").inputs.aspect_ratio).toBe(v);
		}
		const mps: Record<string, number> = { "480p": 0.4, "640p": 0.7, "768p": 1, "1080p": 2 };
		for (const [k, v] of Object.entries(mps)) {
			expect(nodeOfClass(buildH3Graph(base({ resolution: k })), "ResolutionSelector").inputs.megapixels).toBe(v);
		}
	});

	it("非法值一律 throw（§9 绝不静默改写）：比例/分辨率/时长/未知骨架", () => {
		expect(() => buildH3Graph(base({ aspect: "17:9" }))).toThrow(/比例参数无效/);
		expect(() => buildH3Graph(base({ resolution: "720p" }))).toThrow(/分辨率参数无效/); // H3 无 720p 档
		expect(() => buildH3Graph(base({ durationSec: "abc" }))).toThrow(/时长参数无效/);
		expect(() => buildH3Graph(base({ durationSec: 0 }))).toThrow(/时长参数无效/);
		expect(() => buildH3Graph(base({ workflow: "other" }))).toThrow(/未知工作流骨架/);
	});

	it("数字串时长归一为数值；空串比例/分辨率视为缺省", () => {
		const g = buildH3Graph(base({ durationSec: "9", aspect: "", resolution: "" }));
		expect(nodeOfClass(g, "PrimitiveFloat").inputs.value).toBe(9);
		const res = nodeOfClass(g, "ResolutionSelector");
		expect(res.inputs.aspect_ratio).toBe("16:9 (Widescreen)");
		expect(res.inputs.megapixels).toBe(0.4);
	});

	it("素材超限（图9/视3/音3）throw", () => {
		const many = (n: number) => Array.from({ length: n }, (_, i) => ({ file: `f${i}.png` }));
		expect(() => buildH3Graph(base({ images: many(10) }))).toThrow(/图片素材最多 9 张/);
		expect(() => buildH3Graph(base({ videos: many(4) }))).toThrow(/视频素材最多 3 条/);
		expect(() => buildH3Graph(base({ audios: many(4).map((f) => ({ ...f, durationSec: 1 })) }))).toThrow(/音频素材最多 3 条/);
		// 恰在上限=放行
		const ok = buildH3Graph(base({ images: many(9) }));
		expect(nodesOfClass(ok, "LoadImage").length).toBe(9);
	});
});

describe("comfyH3Graph toOfficialTags（@tag 图例 → H3 官方引用标签）", () => {
	it("三种模态转写 + 多位编号 + 普通文本不动", () => {
		expect(toOfficialTags("@Image1 是主角，@Video2 是运镜参考，@Audio3 是配乐")).toBe(
			"<Picture 1> 是主角，<Video 2> 是运镜参考，<Audio 3> 是配乐",
		);
		expect(toOfficialTags("@Image10 压轴")).toBe("<Picture 10> 压轴");
		expect(toOfficialTags("没有胶囊的普通提示词")).toBe("没有胶囊的普通提示词");
	});
});

describe("comfyuiAdapter collectComfyRefs（超限明确报错绝不截断，§9A 第118轮）", () => {
	it("保序收集三模态；空 url 条目过滤", () => {
		const r = collectComfyRefs({
			images: [{ url: "u1", name: "a" }, { url: "" }, { url: "u2" }],
			videos: [{ url: "v1" }],
			audios: [],
		});
		expect(r.images.map((x) => x.url)).toEqual(["u1", "u2"]);
		expect(r.videos.map((x) => x.url)).toEqual(["v1"]);
		expect(r.audios).toEqual([]);
	});

	it("超限 throw（不 warn 不 slice）：图 10 张 / 视 4 条 / 音 4 条", () => {
		const many = (n: number, p: string) => Array.from({ length: n }, (_, i) => ({ url: `${p}${i}` }));
		expect(() => collectComfyRefs({ images: many(10, "i") })).toThrow(/图片素材最多 9 张（当前 10 条）/);
		expect(() => collectComfyRefs({ videos: many(4, "v") })).toThrow(/视频素材最多 3 条（当前 4 条）/);
		expect(() => collectComfyRefs({ audios: many(4, "a") })).toThrow(/音频素材最多 3 条（当前 4 条）/);
		// 恰在上限=放行
		expect(collectComfyRefs({ images: many(9, "i") }).images.length).toBe(9);
	});
});
