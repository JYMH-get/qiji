import { describe, expect, it } from "vitest";
import {
	MIN_LAYER_SCALE,
	pointInSegBox,
	applyMove,
	applyRotate,
	applyScale,
	containFrac,
	containSize,
	handleCursor,
	handleDir,
	isCornerHandle,
	isIdentityTransform,
	normalizeAngle,
	resetTransform,
	rotateVec,
	sameTransform,
	screenToFrame,
	segBoxGeom,
	snapAngle,
	transformCss,
	withSegmentTransform,
	type RtcHandleId,
	type RtcSize,
} from "./rtcTransform";
import { DEFAULT_RTC_TRANSFORM, type RtcDoc, type RtcSegment, type RtcTransform } from "@/types/rtc";

const FRAME: RtcSize = { w: 800, h: 450 };
/** 素材自然尺寸未知时基准=整幅画幅（containSize 的回退），下面多数用例直接用它 */
const BASE: RtcSize = { w: 800, h: 450 };

function t(part: Partial<RtcTransform> = {}): RtcTransform {
	return { ...DEFAULT_RTC_TRANSFORM, ...part };
}

/** 手柄的锚点（对角/对边中点）世界坐标——「缩放时锚点纹丝不动」的断言基准 */
function anchorOf(frame: RtcSize, base: RtcSize, tr: RtcTransform, handle: RtcHandleId) {
	const { hx, hy } = handleDir(handle);
	const g = segBoxGeom(frame, base, tr);
	const v = rotateVec({ x: (-hx * g.w) / 2, y: (-hy * g.h) / 2 }, tr.rotation);
	return { x: g.center.x + v.x, y: g.center.y + v.y };
}

describe("transformCss 变换 → CSS", () => {
	it("恒等变换返回 null——渲染层据此整个省略 transform 属性（回归零差异）", () => {
		expect(transformCss(t())).toBeNull();
		expect(transformCss(t({ rotation: 0, opacity: 1 }))).toBeNull();
		expect(isIdentityTransform(t())).toBe(true);
	});

	it("位移用百分比（基准=图层元素自身=画幅框），顺序 translate→rotate→scale", () => {
		const css = transformCss(t({ x: 0.25, y: -0.5, rotation: 30, scaleX: 2, scaleY: 1.5 }));
		expect(css).toBe("translate(25%, -50%) rotate(30deg) scale(2, 1.5)");
	});

	it("镜像 = 负 scale（尺寸不变、只翻面）", () => {
		expect(transformCss(t({ flipH: true }))).toBe("translate(0%, 0%) rotate(0deg) scale(-1, 1)");
		expect(transformCss(t({ flipV: true, scaleY: 2 }))).toBe("translate(0%, 0%) rotate(0deg) scale(1, -2)");
	});

	it("sameTransform 容浮点误差；镜像位不同即不同", () => {
		expect(sameTransform(t({ x: 0.1 }), t({ x: 0.1 + 1e-9 }))).toBe(true);
		expect(sameTransform(t(), t({ flipH: true }))).toBe(false);
	});
});

describe("containSize 基准尺寸", () => {
	it("素材比画幅更宽 → 上下留白；更高 → 左右留白", () => {
		expect(containSize(FRAME, { w: 1600, h: 400 })).toEqual({ w: 800, h: 200 });
		expect(containSize(FRAME, { w: 450, h: 900 })).toEqual({ w: 225, h: 450 });
	});

	it("自然尺寸未知/非法 → 回退整幅画幅；画幅未测到 → 0", () => {
		expect(containSize(FRAME, null)).toEqual(FRAME);
		expect(containSize(FRAME, { w: 0, h: 100 })).toEqual(FRAME);
		expect(containSize({ w: 0, h: 0 }, { w: 10, h: 10 })).toEqual({ w: 0, h: 0 });
	});
});

describe("containFrac 零测量比例基准（选中框渲染专用）", () => {
	const RF = 16 / 9;

	it("与 containSize 完全同构：像素结果 ÷ 画幅 = 比例结果", () => {
		for (const natural of [
			{ w: 1600, h: 400 },
			{ w: 450, h: 900 },
			{ w: 1920, h: 1080 },
			{ w: 1247, h: 703 },
		]) {
			const px = containSize(FRAME, natural);
			const fr = containFrac(FRAME.w / FRAME.h, natural);
			expect(fr.w).toBeCloseTo(px.w / FRAME.w, 10);
			expect(fr.h).toBeCloseTo(px.h / FRAME.h, 10);
		}
	});

	it("同比例素材 → {1,1}（铺满整幅）；更宽 → 高缩；更高 → 宽缩", () => {
		expect(containFrac(RF, { w: 1920, h: 1080 })).toEqual({ w: 1, h: 1 });
		const wide = containFrac(RF, { w: 3200, h: 800 }); // 4:1
		expect(wide.w).toBe(1);
		expect(wide.h).toBeCloseTo(RF / 4, 10);
		const tall = containFrac(RF, { w: 900, h: 1600 }); // 9:16
		expect(tall.h).toBe(1);
		expect(tall.w).toBeCloseTo(9 / 16 / RF, 10);
	});

	it("自然尺寸未知/非法 → {1,1}（与图层元素的 contain 回退一致）；画幅比非法 → 0", () => {
		expect(containFrac(RF, null)).toEqual({ w: 1, h: 1 });
		expect(containFrac(RF, { w: 0, h: 100 })).toEqual({ w: 1, h: 1 });
		expect(containFrac(0, { w: 10, h: 10 })).toEqual({ w: 0, h: 0 });
	});
});

describe("pointInSegBox 画面点选命中（预览框选素材）", () => {
	it("缺省变换：整幅画幅内命中、幅外落空", () => {
		expect(pointInSegBox({ x: 400, y: 225 }, FRAME, BASE, t())).toBe(true);
		expect(pointInSegBox({ x: 1, y: 1 }, FRAME, BASE, t())).toBe(true);
		expect(pointInSegBox({ x: 801, y: 225 }, FRAME, BASE, t())).toBe(false);
	});

	it("缩放+平移后热区跟随画面：框内命中、原位置落空", () => {
		// 0.5 倍缩放 + 右移 25% 画幅宽 → 中心 (600,225)、半宽 200 半高 112.5
		const tr = t({ scaleX: 0.5, scaleY: 0.5, x: 0.25 });
		expect(pointInSegBox({ x: 600, y: 225 }, FRAME, BASE, tr)).toBe(true);
		expect(pointInSegBox({ x: 401, y: 225 }, FRAME, BASE, tr)).toBe(true); // 左缘 600-200=400
		expect(pointInSegBox({ x: 398, y: 225 }, FRAME, BASE, tr)).toBe(false);
		expect(pointInSegBox({ x: 100, y: 225 }, FRAME, BASE, tr)).toBe(false); // 原中心一带已让空
	});

	it("旋转 90° 后按旋转后的矩形判定（宽高互换）", () => {
		const tr = t({ scaleX: 0.5, scaleY: 0.5, rotation: 90 });
		// 未旋转半宽 200/半高 112.5 → 旋转后屏幕上 x 向半径=112.5、y 向半径=200
		expect(pointInSegBox({ x: 400 + 150, y: 225 }, FRAME, BASE, tr)).toBe(false); // 150>112.5
		expect(pointInSegBox({ x: 400, y: 225 + 150 }, FRAME, BASE, tr)).toBe(true); // 150<200
	});

	it("contain 基准（竖版素材进横画幅）：左右留黑区落空", () => {
		const base = { w: 225, h: 450 }; // 9:16 素材 contain 进 800×450
		expect(pointInSegBox({ x: 400, y: 225 }, FRAME, base, t())).toBe(true);
		expect(pointInSegBox({ x: 100, y: 225 }, FRAME, base, t())).toBe(false); // 左黑边
	});
});

describe("segBoxGeom 选中框几何", () => {
	it("缺省变换 = 画幅正中、与基准同尺寸", () => {
		const g = segBoxGeom(FRAME, BASE, t());
		expect(g.center).toEqual({ x: 400, y: 225 });
		expect([g.w, g.h]).toEqual([800, 450]);
		expect(g.corners[0]).toEqual({ x: 0, y: 0 });
		expect(g.corners[2]).toEqual({ x: 800, y: 450 });
	});

	it("位置是比例：x=0.25 → 右移 1/4 画幅宽；缩放乘在基准上", () => {
		const g = segBoxGeom(FRAME, BASE, t({ x: 0.25, y: -0.5, scaleX: 0.5, scaleY: 0.5 }));
		expect(g.center).toEqual({ x: 400 + 200, y: 225 - 225 });
		expect([g.w, g.h]).toEqual([400, 225]);
	});

	it("旋转 90° 顺时针：左上角转到右上（画幅坐标 y 向下）", () => {
		const g = segBoxGeom(FRAME, { w: 200, h: 100 }, t({ rotation: 90 }));
		const nw = g.corners[0];
		expect(nw.x).toBeCloseTo(400 + 50, 6);
		expect(nw.y).toBeCloseTo(225 - 100, 6);
	});
});

describe("screenToFrame / applyMove 坐标换算", () => {
	it("屏幕坐标减去画幅框左上角", () => {
		expect(screenToFrame(130, 90, { left: 30, top: 40 })).toEqual({ x: 100, y: 50 });
	});

	it("移动：像素位移 → 位置比例增量（按画幅宽高各自归一）", () => {
		const next = applyMove(t({ x: 0.1 }), { x: 80, y: -45 }, FRAME);
		expect(next.x).toBeCloseTo(0.2, 9); // 80/800
		expect(next.y).toBeCloseTo(-0.1, 9); // -45/450
	});

	it("画幅未测到 → 原样返回（绝不把 NaN 写进数据）", () => {
		const t0 = t({ x: 0.3 });
		expect(applyMove(t0, { x: 10, y: 10 }, { w: 0, h: 0 })).toBe(t0);
	});
});

describe("applyScale 缩放解算", () => {
	it("拖角等比：拖到两倍 → scale=2，且对角锚点纹丝不动", () => {
		const t0 = t();
		const next = applyScale({ t0, frame: FRAME, base: BASE, pointer: { x: 1600, y: 900 }, handle: "se", uniform: true });
		expect(next.scaleX).toBeCloseTo(2, 9);
		expect(next.scaleY).toBeCloseTo(2, 9);
		expect(next.x).toBeCloseTo(0.5, 9);
		expect(next.y).toBeCloseTo(0.5, 9);
		const a0 = anchorOf(FRAME, BASE, t0, "se");
		const a1 = anchorOf(FRAME, BASE, next, "se");
		expect(a1.x).toBeCloseTo(a0.x, 6);
		expect(a1.y).toBeCloseTo(a0.y, 6);
	});

	it("拖边=单向：只动该轴，另一轴分毫不动", () => {
		const next = applyScale({ t0: t(), frame: FRAME, base: BASE, pointer: { x: 1200, y: 999 }, handle: "e", uniform: true });
		expect(next.scaleX).toBeCloseTo(1.5, 9);
		expect(next.scaleY).toBe(1); // uniform 对边手柄无效
		expect(next.x).toBeCloseTo(0.25, 9);
		expect(next.y).toBe(0);
	});

	it("拖角非等比（Shift/关等比）：两轴各按各的位移", () => {
		const next = applyScale({ t0: t(), frame: FRAME, base: BASE, pointer: { x: 1200, y: 675 }, handle: "se", uniform: false });
		expect(next.scaleX).toBeCloseTo(1.5, 9);
		expect(next.scaleY).toBeCloseTo(1.5, 9);
		const free = applyScale({ t0: t(), frame: FRAME, base: BASE, pointer: { x: 1200, y: 450 }, handle: "se", uniform: false });
		expect(free.scaleX).toBeCloseTo(1.5, 9);
		expect(free.scaleY).toBeCloseTo(1, 9);
	});

	it("已旋转的框：锚点在旋转后的世界位置上仍纹丝不动", () => {
		const t0 = t({ rotation: 37, scaleX: 0.8, scaleY: 1.3, x: -0.2, y: 0.1 });
		for (const h of ["nw", "ne", "se", "sw", "n", "e", "s", "w"] as RtcHandleId[]) {
			const next = applyScale({ t0, frame: FRAME, base: BASE, pointer: { x: 517, y: 133 }, handle: h, uniform: isCornerHandle(h) });
			const a0 = anchorOf(FRAME, BASE, t0, h);
			const a1 = anchorOf(FRAME, BASE, next, h);
			expect(a1.x).toBeCloseTo(a0.x, 6);
			expect(a1.y).toBeCloseTo(a0.y, 6);
			expect(next.rotation).toBe(37); // 缩放绝不动旋转
		}
	});

	it("拖过锚点不做镜像，钳到下限；非法输入原样返回", () => {
		const shrunk = applyScale({ t0: t(), frame: FRAME, base: BASE, pointer: { x: -500, y: -500 }, handle: "se", uniform: true });
		expect(shrunk.scaleX).toBe(MIN_LAYER_SCALE);
		expect(shrunk.scaleY).toBe(MIN_LAYER_SCALE);
		const t0 = t();
		expect(applyScale({ t0, frame: { w: 0, h: 0 }, base: BASE, pointer: { x: 1, y: 1 }, handle: "se", uniform: true })).toBe(t0);
	});
});

describe("applyRotate / 角度工具", () => {
	it("按下点到当前点的角差叠加到起始角（顺时针为正）", () => {
		const center = { x: 400, y: 225 };
		const next = applyRotate(t(), center, { x: 400, y: 425 }, { x: 600, y: 225 }, false);
		expect(next.rotation).toBeCloseTo(-90, 6); // 底 → 右 = 逆时针 90°
	});

	it("Shift 吸附 15° 档", () => {
		const center = { x: 0, y: 0 };
		const raw = applyRotate(t(), center, { x: 100, y: 0 }, { x: 100, y: 12 }, false);
		expect(Math.abs(raw.rotation)).toBeGreaterThan(0);
		const snapped = applyRotate(t(), center, { x: 100, y: 0 }, { x: 100, y: 12 }, true);
		expect(snapped.rotation % 15).toBe(0);
	});

	it("归一到 (-180,180]，绕圈不无限增长", () => {
		expect(normalizeAngle(370)).toBe(10);
		expect(normalizeAngle(-190)).toBe(170);
		expect(normalizeAngle(180)).toBe(180);
		expect(snapAngle(7)).toBe(0);
		expect(snapAngle(8)).toBe(15);
	});

	it("旋转只动 rotation，缩放/位置原样带走", () => {
		const t0 = t({ scaleX: 1.7, x: 0.3, opacity: 0.5 });
		const next = applyRotate(t0, { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }, false);
		expect(next.scaleX).toBe(1.7);
		expect(next.x).toBe(0.3);
		expect(next.opacity).toBe(0.5);
		expect(next.rotation).toBeCloseTo(90, 6);
	});
});

describe("handleCursor 手柄光标随框旋转", () => {
	it("未旋转时按方向给光标", () => {
		expect(handleCursor("e", 0)).toBe("ew-resize");
		expect(handleCursor("n", 0)).toBe("ns-resize");
		expect(handleCursor("se", 0)).toBe("nwse-resize");
		expect(handleCursor("ne", 0)).toBe("nesw-resize");
	});

	it("框转 90° 后，右手柄在屏幕上变成上下方向", () => {
		expect(handleCursor("e", 90)).toBe("ns-resize");
		expect(handleCursor("se", 90)).toBe("nesw-resize");
	});
});

/* ── doc 更新 ── */

function seg(id: string, extra: Partial<RtcSegment> = {}): RtcSegment {
	return { id, kind: "media", media: "video", assetId: `a-${id}`, uri: `u://${id}`, targetStartUs: 1000, targetDurationUs: 5000, sourceStartUs: 200, sourceDurationUs: 5000, ...extra };
}

function makeDoc(): RtcDoc {
	return {
		id: "d",
		name: "n",
		fps: 30,
		tracks: [
			{ id: "v1", type: "video", segments: [seg("s1"), seg("s2")] },
			{ id: "v2", type: "video", segments: [seg("s3")] },
		],
	};
}

describe("withSegmentTransform 写回 doc", () => {
	it("只动 transform 一个字段：时间窗口/素材引用原样带走", () => {
		const d0 = makeDoc();
		const d1 = withSegmentTransform(d0, "s2", t({ x: 0.2, scaleX: 1.5 }));
		const s2 = d1.tracks[0].segments[1];
		expect(s2.transform).toEqual(t({ x: 0.2, scaleX: 1.5 }));
		expect(s2.targetStartUs).toBe(1000);
		expect(s2.targetDurationUs).toBe(5000);
		expect(s2.sourceStartUs).toBe(200);
		expect(s2.sourceDurationUs).toBe(5000);
		expect(s2.assetId).toBe("a-s2");
		expect(s2.uri).toBe("u://s2");
	});

	it("同轨其它片段与其它轨道保持引用不变（最小重建）", () => {
		const d0 = makeDoc();
		const d1 = withSegmentTransform(d0, "s2", t({ x: 0.2 }));
		expect(d1).not.toBe(d0);
		expect(d1.tracks[0].segments[0]).toBe(d0.tracks[0].segments[0]);
		expect(d1.tracks[1]).toBe(d0.tracks[1]);
	});

	it("值未变 / 片段不存在 → 返回原 doc 引用（commit 视为 no-op，不进撤销栈）", () => {
		const d0 = makeDoc();
		expect(withSegmentTransform(d0, "s1", t())).toBe(d0); // 缺省 ≡ 恒等
		expect(withSegmentTransform(d0, "不存在", t({ x: 1 }))).toBe(d0);
		const d1 = withSegmentTransform(d0, "s1", t({ x: 0.3 }));
		expect(withSegmentTransform(d1, "s1", t({ x: 0.3 }))).toBe(d1);
	});

	it("回到恒等 → 删除 transform 字段（存量文档保持干净形态）", () => {
		const d1 = withSegmentTransform(makeDoc(), "s1", t({ x: 0.3, rotation: 20 }));
		const d2 = withSegmentTransform(d1, "s1", resetTransform());
		expect("transform" in d2.tracks[0].segments[0]).toBe(false);
		expect(d2.tracks[0].segments[0].targetStartUs).toBe(1000);
	});

	it("写入的是副本：改回传对象不会串改 doc", () => {
		const tr = t({ x: 0.4 });
		const d1 = withSegmentTransform(makeDoc(), "s1", tr);
		tr.x = 99;
		expect(d1.tracks[0].segments[0].transform?.x).toBe(0.4);
	});
});
