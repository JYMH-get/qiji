import { describe, it, expect } from "vitest";
import { buildImageParams, estimateCost } from "./genParams";

it('隐藏的文本费率不显示预扣价或残留目录价格', () => {
  expect(estimateCost({ pricingHidden: true, cost: 99, tokenPricing: { enabled: true } }, {})).toBeNull();
  expect(estimateCost({ pricingHidden: true }, {})).toBeNull();
  expect(estimateCost({}, {})).toBeNull();
});

it("文本按 token 计费显示预扣10积分，忽略保留的旧按次价格", () => {
  expect(estimateCost({ cost: 99, tokenPricing: { enabled: true } }, {})).toBe(10);
  expect(estimateCost({ cost: 7, tokenPricing: { enabled: false } }, {})).toBe(7);
});

it('渠道商将某分辨率秒价设为零时，免费档位不回退到默认整次价', () => {
  const model = { cost: 600, costField: 'duration', costPerUnit: 40,
    costRules: [{ when: { resolution: '720p' }, costPerUnit: 0 }] };
  expect(estimateCost(model, { duration: 5, resolution: '720p' })).toBe(0);
  expect(estimateCost(model, { duration: 5, resolution: '1080p' })).toBe(200);
});

describe("图片生成公共请求参数", () => {
	it("保留原比例字段，只补齐缺失的公共比例", () => {
		expect(buildImageParams({ aspect: "16:9", resolution: "2k", quality: "high" }, [
			{ v: "1k" }, { v: "2k" }, { v: "4k" },
		])).toEqual({ aspect: "16:9", aspect_ratio: "16:9", resolution: "2k", quality: "high" });
	});
	it("保留扩展参数和显式值，不按目录改档、改大小写或覆盖公共比例", () => {
		const params = Object.freeze({ aspect: "1:1", aspect_ratio: "9:16", resolution: "8K", quality: "custom",
			size: "4321x8765", imageSize: "4K", aspectRatio: "3:4", reference_strength: 0.8,
			generationConfig: { seed: 123, responseModalities: ["IMAGE"] } });
		const result = buildImageParams(params, [{ v: "1k" }, { v: "2k" }]);
		expect(result).toStrictEqual(params);
		expect(result).not.toBe(params);
	});
	it("已有空值、零值或布尔值不被默认值改写", () => {
		for (const value of [null, '', 0, false]) {
			const params = { aspect_ratio: value, resolution: value, quality: value };
			expect(buildImageParams(params)).toStrictEqual(params);
		}
	});
	it("缺失公共值时复用显式上游别名，原别名继续保留", () => {
		expect(buildImageParams({ aspectRatio: "3:4", imageSize: "4K" }, [{ v: "2k" }]))
			.toEqual({ aspectRatio: "3:4", imageSize: "4K", aspect_ratio: "3:4", resolution: "4K", quality: "high" });
		expect(buildImageParams({}, [{ v: "1k" }])).toEqual({ aspect_ratio: "16:9", resolution: "1k", quality: "high" });
	});
	it("仅有 Gemini 原生嵌套配置时按其补缺，不制造 2K/16:9 冲突", () => {
		const generationConfig = { imageConfig: { imageSize: "4K", aspectRatio: "1:1" }, temperature: 0.6 };
		expect(buildImageParams({ generationConfig }, [{ v: "2k" }]))
			.toEqual({ generationConfig, aspect_ratio: "1:1", resolution: "4K", quality: "high" });
		const explicit = { generationConfig, aspect_ratio: "3:4", resolution: "2k", quality: "low" };
		expect(buildImageParams(explicit)).toEqual(explicit);
	});
});

/** 与服务端 resolveModelCost + refVideoBilling 同尺（第143轮）：预估必须等于实扣 */
describe("estimateCost 参考视频按秒折算", () => {
	const mini = { cost: 30, costField: "duration", costPerUnit: 2, refVideoSecondsWeight: 1 };

	it("无参考视频：按时长计费不变", () => {
		expect(estimateCost(mini, { duration: 10 })).toBe(20);
	});

	it("系数1：计费秒数 = duration + 参考视频秒（与出片同价）", () => {
		// 10s 出片 + 17 参考秒（15+2，调用方已逐条 ceil）= 27 × 2 = 54
		expect(estimateCost(mini, { duration: 10 }, 17)).toBe(54);
	});

	it("系数0.5：折半折算 + 四舍五入与服务端一致", () => {
		const m = { ...mini, refVideoSecondsWeight: 0.5, costPerUnit: 2.5 };
		// 10 + 0.5×17 = 18.5 × 2.5 = 46.25 → 46（Math.round，与 resolveModelCost 同）
		expect(estimateCost(m, { duration: 10 }, 17)).toBe(46);
	});

	it("无系数模型：refVideoSeconds 不生效", () => {
		const m = { cost: 30, costField: "duration", costPerUnit: 2 };
		expect(estimateCost(m, { duration: 10 }, 17)).toBe(20);
	});

	it("档位路由价照吃折算秒数（1080p 档每秒价）", () => {
		const vip = {
			cost: 45, costField: "duration", costPerUnit: 3, refVideoSecondsWeight: 1,
			costRules: [{ when: { resolution: "1080p" }, cost: 113, costPerUnit: 7.5 }],
		};
		// (10 + 15) × 7.5 = 187.5 → 188（与服务端冒烟 D 同数值）
		expect(estimateCost(vip, { duration: 10, resolution: "1080p" }, 15)).toBe(188);
	});

	it("基础时长缺失：不折算、维持兜底固定价（与服务端同路径）", () => {
		expect(estimateCost(mini, {}, 17)).toBe(30);
	});

	it("按次模型（无 costField）不受影响", () => {
		expect(estimateCost({ cost: 45 }, { duration: 10 }, 17)).toBe(45);
	});

	it("缺模型返回 null", () => {
		expect(estimateCost(undefined, { duration: 10 }, 17)).toBeNull();
	});
});


describe("自动路由输入视频档位计费", () => {
 const model = { cost: 999, refVideoSecondsWeight: 1, costRules: [
  { when: { duration: "5", resolution: "720p" }, cost: 250 },
  { when: { duration: "10", resolution: "720p" }, cost: 600 },
 ] };
 it("保留输出档位，以该档每秒价格折算输入视频", () => {
  expect(estimateCost(model, { duration: 5, resolution: "720p" }, 4)).toBe(450);
  expect(estimateCost(model, { duration: 10, resolution: "720p" }, 4)).toBe(840);
 });
 it("支持半价输入、关闭输入计费和无输入", () => {
  expect(estimateCost({ ...model, refVideoSecondsWeight: 0.5 }, { duration: 5, resolution: "720p" }, 4)).toBe(350);
  expect(estimateCost({ ...model, refVideoSecondsWeight: 0 }, { duration: 5, resolution: "720p" }, 4)).toBe(250);
  expect(estimateCost(model, { duration: 5, resolution: "720p" })).toBe(250);
 });
});
