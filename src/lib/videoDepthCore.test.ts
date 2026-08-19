import { describe, it, expect } from "vitest";
import {
	DEPTH_VIDEO_FPS_FALLBACK,
	FrameQueue,
	MAX_DEPTH_FRAMES,
	clampSourceFps,
	evenDim,
	grayWithBounds,
	inferSize,
	planFrameTimes,
	rawDepthBounds,
	smoothDepthBounds,
} from "./videoDepthCore";

describe("clampSourceFps（原帧率不抽帧）", () => {
	it("常规原帧率原样保留（含分数帧率）", () => {
		expect(clampSourceFps(24)).toBe(24);
		expect(clampSourceFps(29.97)).toBe(29.97);
		expect(clampSourceFps(60)).toBe(60);
	});
	it("解析失败/非法回退 30", () => {
		expect(clampSourceFps(undefined)).toBe(DEPTH_VIDEO_FPS_FALLBACK);
		expect(clampSourceFps(NaN)).toBe(30);
		expect(clampSourceFps(0)).toBe(30);
		expect(clampSourceFps(-5)).toBe(30);
	});
	it(">60 夹到 60、<1 夹到 1", () => {
		expect(clampSourceFps(120)).toBe(60);
		expect(clampSourceFps(0.5)).toBe(1);
	});
});

describe("planFrameTimes", () => {
	it("2 秒 @16fps = 32 帧，帧心采样、严格递增且都在时长内", () => {
		const t = planFrameTimes(2, 16);
		expect(t).toHaveLength(32);
		expect(t[0]).toBeCloseTo(0.5 / 16, 6);
		expect(t[31]).toBeCloseTo(31.5 / 16, 6);
		for (let i = 1; i < t.length; i++) expect(t[i]).toBeGreaterThan(t[i - 1]);
		expect(t.every((v) => v >= 0 && v < 2)).toBe(true);
	});
	it("末帧钳在时长内侧（不越界 seek）", () => {
		const t = planFrameTimes(1, 8); // 8 帧，末帧 7.5/8=0.9375 < 0.999
		expect(t[t.length - 1]).toBeLessThan(1);
		const t2 = planFrameTimes(0.05, 8); // 极短视频：1 帧且钳到 duration-0.001
		expect(t2).toHaveLength(1);
		expect(t2[0]).toBeLessThanOrEqual(0.049);
	});
	it("非法时长/帧率返回空数组", () => {
		expect(planFrameTimes(0, 16)).toEqual([]);
		expect(planFrameTimes(NaN, 16)).toEqual([]);
		expect(planFrameTimes(Infinity, 16)).toEqual([]);
		expect(planFrameTimes(5, 0)).toEqual([]);
	});
	it("超长视频帧数超过 MAX_DEPTH_FRAMES 时原样返回（供调用方明确报错，不静默截断）", () => {
		const t = planFrameTimes(10_000, 16); // 16 万帧 → 钳到 maxFrames 缺省 MAX+1
		expect(t.length).toBe(MAX_DEPTH_FRAMES + 1);
		expect(t.length).toBeGreaterThan(MAX_DEPTH_FRAMES);
	});
});

describe("rawDepthBounds / smoothDepthBounds", () => {
	it("提取 min/max；全 NaN/空返回 null", () => {
		expect(rawDepthBounds([3, 1, 2])).toEqual({ min: 1, max: 3 });
		expect(rawDepthBounds([])).toBeNull();
		expect(rawDepthBounds([NaN, NaN])).toBeNull();
	});
	it("无前帧（或 alpha=0）= 每帧独立", () => {
		const cur = { min: 1, max: 9 };
		expect(smoothDepthBounds(null, cur)).toEqual(cur);
		expect(smoothDepthBounds({ min: 0, max: 100 }, cur, 0)).toEqual(cur);
	});
	it("EMA 数学正确：next = prev·a + cur·(1-a)", () => {
		const out = smoothDepthBounds({ min: 0, max: 100 }, { min: 10, max: 50 }, 0.8);
		expect(out.min).toBeCloseTo(0 * 0.8 + 10 * 0.2, 6);
		expect(out.max).toBeCloseTo(100 * 0.8 + 50 * 0.2, 6);
	});
	it("恒定输入下收敛到输入值（单镜头稳定）", () => {
		let b: { min: number; max: number } | null = { min: 0, max: 100 };
		for (let i = 0; i < 60; i++) b = smoothDepthBounds(b, { min: 20, max: 40 }, 0.8);
		expect(b!.min).toBeCloseTo(20, 1);
		expect(b!.max).toBeCloseTo(40, 1);
	});
});

describe("grayWithBounds", () => {
	it("按固定范围映射灰度：min→0、max→255、中点→~128", () => {
		const g = grayWithBounds([0, 5, 10], { min: 0, max: 10 });
		expect(g[0]).toBe(0);
		expect(g[1]).toBe(128); // 127.5 四舍五入
		expect(g[2]).toBe(255);
	});
	it("越界值钳到 0/255（平滑标定下当前帧可能越出范围）", () => {
		const g = grayWithBounds([-5, 20], { min: 0, max: 10 });
		expect(g[0]).toBe(0);
		expect(g[1]).toBe(255);
	});
	it("范围退化返回全 128 中灰（与图片侧同语义）", () => {
		const g = grayWithBounds([7, 7, 7], { min: 7, max: 7 });
		expect(Array.from(g)).toEqual([128, 128, 128]);
	});
});

describe("FrameQueue（抽帧↔推理流水线管道）", () => {
	it("FIFO 顺序 + close 后排空返回 null", async () => {
		const q = new FrameQueue<number>(4);
		await q.push(1);
		await q.push(2);
		q.close();
		expect(await q.pull()).toBe(1);
		expect(await q.pull()).toBe(2);
		expect(await q.pull()).toBeNull();
	});
	it("背压：队满 push 等待，直到 pull 腾出空位", async () => {
		const q = new FrameQueue<number>(1);
		await q.push(1);
		let pushed = false;
		const p = q.push(2).then(() => { pushed = true; });
		await new Promise((r) => setTimeout(r, 10));
		expect(pushed).toBe(false); // 队满卡住
		expect(await q.pull()).toBe(1);
		await p;
		expect(pushed).toBe(true);
		expect(await q.pull()).toBe(2);
	});
	it("pull 先等、push 后到（消费者先就位）", async () => {
		const q = new FrameQueue<number>(2);
		const p = q.pull();
		await q.push(7);
		expect(await p).toBe(7);
	});
	it("pullImmediate 非阻塞：有缓冲即取、空返回 null", async () => {
		const q = new FrameQueue<number>(2);
		expect(q.pullImmediate()).toBeNull();
		await q.push(3);
		expect(q.pullImmediate()).toBe(3);
	});
	it("fail 让两端等待立即以同一错误终止", async () => {
		const q = new FrameQueue<number>(1);
		const pulling = q.pull();
		q.fail(new Error("boom"));
		await expect(pulling).rejects.toThrow("boom");
		await expect(q.push(1)).rejects.toThrow("boom");
	});
});

describe("evenDim / inferSize", () => {
	it("偶数化：向下取偶且不小于 2", () => {
		expect(evenDim(1023)).toBe(1022);
		expect(evenDim(1024)).toBe(1024);
		expect(evenDim(1)).toBe(2);
	});
	it("推理输入降采样：长边压到上限保持比例；小图原样", () => {
		expect(inferSize(1920, 1080, 720)).toEqual({ w: 720, h: 405 });
		expect(inferSize(1080, 1920, 720)).toEqual({ w: 405, h: 720 });
		expect(inferSize(640, 360, 720)).toEqual({ w: 640, h: 360 });
	});
	it("默认上限 1036（2×518 供采样，精度零损失）：1080p 原样、4K 压半", () => {
		expect(inferSize(1920, 1080)).toEqual({ w: 1036, h: 583 });
		expect(inferSize(1024, 576)).toEqual({ w: 1024, h: 576 });
		expect(inferSize(3840, 2160)).toEqual({ w: 1036, h: 583 });
	});
});
