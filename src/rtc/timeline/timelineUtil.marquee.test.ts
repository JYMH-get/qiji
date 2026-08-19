/** marqueeSelectIds —— 时间轴框选纯函数单测 */
import { describe, expect, it } from "vitest";
import { marqueeSelectIds } from "./timelineUtil";

const seg = (id: string, s: number, d: number) => ({ id, targetStartUs: s, targetDurationUs: d });

describe("marqueeSelectIds 框选命中", () => {
	const rows = [
		{ segments: [seg("a", 0, 1_000_000), seg("b", 2_000_000, 1_000_000)] },
		{ locked: true, segments: [seg("locked", 0, 9_000_000)] },
		{ segments: [seg("c", 500_000, 1_000_000)] },
	];
	const tops = [28, 60, 124, 188]; // 行0=半高32、行1/2=64

	it("矩形 行×时间 相交即命中；锁定轨不参与", () => {
		// 纵向覆盖全部行、时间 [0.4s, 2.1s)
		expect(marqueeSelectIds(rows, tops, 30, 180, 400_000, 2_100_000)).toEqual(["a", "b", "c"]);
		// 只罩第一行
		expect(marqueeSelectIds(rows, tops, 30, 55, 0, 9_000_000)).toEqual(["a", "b"]);
		// 时间窗只到 0.6s（b 在 2s 起不相交；c 从 0.5s 起恰好搭上）
		expect(marqueeSelectIds(rows, tops, 30, 180, 0, 600_000)).toEqual(["a", "c"]);
		// 时间窗只到 0.4s（c 从 0.5s 起也不搭）
		expect(marqueeSelectIds(rows, tops, 30, 180, 0, 400_000)).toEqual(["a"]);
	});

	it("y/t 顺序无关（内部翻正）；零相交返回空", () => {
		expect(marqueeSelectIds(rows, tops, 180, 30, 2_100_000, 400_000)).toEqual(["a", "b", "c"]);
		expect(marqueeSelectIds(rows, tops, 0, 10, 0, 9_000_000)).toEqual([]); // 矩形在标尺上方
	});
});
