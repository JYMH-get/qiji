import { describe, it, expect } from "vitest";
import { detectTrimRect, type PixelGrid } from "./imageTrim";

/**
 * imageTrim 语义锁定：
 *  - 均匀色边框（不限纯白）被裁到内容外接矩形；
 *  - 无边框/空白格/退化尺寸 原样返回；
 *  - 单边内缩上限 maxTrimRatio 兜底（超厚边框只裁到上限）；
 *  - 边框行里的少量噪点（低于 contentRatio 占比）不阻止裁剪。
 */

/** 合成图：bg 底色 + 若干实心矩形 */
function grid(w: number, h: number, bg: [number, number, number], rects: { x: number; y: number; w: number; h: number; c: [number, number, number] }[] = []): PixelGrid {
	const data = new Uint8ClampedArray(w * h * 4);
	for (let i = 0; i < w * h; i++) {
		data[i * 4] = bg[0];
		data[i * 4 + 1] = bg[1];
		data[i * 4 + 2] = bg[2];
		data[i * 4 + 3] = 255;
	}
	for (const r of rects) {
		for (let y = r.y; y < r.y + r.h; y++) {
			for (let x = r.x; x < r.x + r.w; x++) {
				const i = (y * w + x) * 4;
				data[i] = r.c[0];
				data[i + 1] = r.c[1];
				data[i + 2] = r.c[2];
			}
		}
	}
	return { data, width: w, height: h };
}

const RED: [number, number, number] = [200, 40, 40];
const WHITE: [number, number, number] = [255, 255, 255];

describe("detectTrimRect", () => {
	it("白边框：裁到内容外接矩形", () => {
		const img = grid(100, 100, WHITE, [{ x: 10, y: 14, w: 80, h: 72, c: RED }]);
		expect(detectTrimRect(img)).toEqual({ x: 10, y: 14, w: 80, h: 72 });
	});

	it("非白底色（米色边框）：背景取四角采样，同样裁掉", () => {
		const img = grid(100, 100, [242, 236, 220], [{ x: 8, y: 8, w: 84, h: 84, c: [30, 60, 120] }]);
		expect(detectTrimRect(img)).toEqual({ x: 8, y: 8, w: 84, h: 84 });
	});

	it("无边框（内容满幅）：原样返回", () => {
		const img = grid(100, 100, RED);
		// 内容色即四角色=背景，但立刻命中「空白格不裁」语义 → 全幅
		expect(detectTrimRect(img)).toEqual({ x: 0, y: 0, w: 100, h: 100 });
	});

	it("空白格（全图背景）：不裁", () => {
		const img = grid(100, 100, WHITE);
		expect(detectTrimRect(img)).toEqual({ x: 0, y: 0, w: 100, h: 100 });
	});

	it("超厚边框：单边内缩钳在 maxTrimRatio 上限", () => {
		// 40px 边框 > 100×0.2=20 上限 → 四边各只裁 20
		const img = grid(100, 100, WHITE, [{ x: 40, y: 40, w: 20, h: 20, c: RED }]);
		expect(detectTrimRect(img)).toEqual({ x: 20, y: 20, w: 60, h: 60 });
	});

	it("边框行少量噪点（低于 contentRatio 占比）不阻止裁剪", () => {
		const img = grid(200, 200, WHITE, [
			{ x: 20, y: 20, w: 160, h: 160, c: RED },
			{ x: 5, y: 5, w: 2, h: 1, c: [0, 0, 0] }, // 顶部边框行里 2 个噪点（<200×0.02=4）
		]);
		expect(detectTrimRect(img)).toEqual({ x: 20, y: 20, w: 160, h: 160 });
	});

	it("渐变噪点在 fuzz 容差内视为背景", () => {
		const img = grid(100, 100, WHITE, [
			{ x: 0, y: 0, w: 100, h: 12, c: [240, 240, 240] }, // 顶部浅灰带（与白差 15 < fuzz 28）
			{ x: 10, y: 12, w: 80, h: 80, c: RED },
		]);
		expect(detectTrimRect(img)).toEqual({ x: 10, y: 12, w: 80, h: 80 });
	});

	it("退化尺寸原样返回；极小内容只按单边上限内缩（不裁穿）", () => {
		expect(detectTrimRect(grid(4, 4, WHITE))).toEqual({ x: 0, y: 0, w: 4, h: 4 });
		// 内容仅 4px（远小于格子）：四边各裁到上限 40×0.2=8 即止，不会一路裁到内容
		const img = grid(40, 40, WHITE, [{ x: 18, y: 18, w: 4, h: 4, c: RED }]);
		expect(detectTrimRect(img)).toEqual({ x: 8, y: 8, w: 24, h: 24 });
	});
});
