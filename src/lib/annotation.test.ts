import { describe, expect, it } from "vitest";
import {
	applyEraseStroke,
	elementAnchor,
	MAX_ELEMENTS,
	MAX_MASKS_PER_ELEMENT,
	newAnnoId,
	normalizedRect,
	sanitizeAnnotationDoc,
	simplifyPoints,
	snapToStroke,
	translateElement,
	type AnnoArrow,
	type AnnoPen,
	type AnnoShapeRect,
	type AnnoStamp,
} from "./annotation";
import {
	BUILTIN_STAMPS,
	konvaSpecFor,
	maskDashFor,
	maskSpec,
	PEN_TENSION,
} from "./annotationRender";
import {
	applyH,
	baseQuadOf,
	flipQuad,
	homographyFromQuads,
	invertH,
	isAffineH,
	quadBBox,
	quadCenter,
	quadOfElement,
	rotateQuad,
	withElementQuad,
} from "./annotationXform";

describe("annotation 模型", () => {
	it("newAnnoId 连续生成不重复", () => {
		const a = newAnnoId();
		const b = newAnnoId();
		expect(a).not.toBe(b);
	});

	it("normalizedRect：负向拖拽翻正", () => {
		expect(normalizedRect(100, 80, 20, 30)).toEqual({ x: 20, y: 30, w: 80, h: 50 });
		expect(normalizedRect(0, 0, 10, 10)).toEqual({ x: 0, y: 0, w: 10, h: 10 });
	});
});

describe("simplifyPoints（停顿转曲线的简化核心）", () => {
	it("共线冗余点被删掉，端点保留", () => {
		const pts: number[] = [];
		for (let i = 0; i <= 10; i++) pts.push(i, 0);
		expect(simplifyPoints(pts, 1)).toEqual([0, 0, 10, 0]);
	});

	it("超出容差的拐点保留", () => {
		const pts = [0, 0, 5, 8, 10, 0];
		expect(simplifyPoints(pts, 3)).toEqual(pts);
		expect(simplifyPoints(pts, 10)).toEqual([0, 0, 10, 0]);
	});

	it("两点及以下原样返回；不改入参", () => {
		const pts = [1, 2, 3, 4];
		const out = simplifyPoints(pts, 5);
		expect(out).toEqual(pts);
		expect(out).not.toBe(pts);
	});
});

describe("translateElement", () => {
	it("pen：全部点位平移", () => {
		const el: AnnoPen = { id: "a", kind: "pen", points: [0, 0, 10, 10], color: "#fff", width: 4 };
		expect(translateElement(el, 5, -3).points).toEqual([5, -3, 15, 7]);
	});
	it("蒙版随元素移动（相对锚点坐标不需改写，绝对位置自动跟随）", () => {
		const el: AnnoPen = {
			id: "a", kind: "pen", points: [100, 100, 200, 100], color: "#fff", width: 4,
			masks: [{ points: [50, -10, 50, 10], width: 30 }],
		};
		const moved = translateElement(el, 30, 40);
		// 蒙版相对坐标原样保留
		expect(moved.masks).toEqual(el.masks);
		// 绝对位置 = 新锚点 + 相对坐标 → 跟随移动
		const a = elementAnchor(moved);
		expect([a.x + moved.masks![0].points[0], a.y + moved.masks![0].points[1]]).toEqual([180, 130]);
	});
	it("arrow：起终点平移", () => {
		const el: AnnoArrow = { id: "a", kind: "arrow", points: [0, 0, 10, 10], color: "#fff", width: 4 };
		expect(translateElement(el, 1, 2).points).toEqual([1, 2, 11, 12]);
	});
	it("rect：x/y 平移，宽高不变", () => {
		const el: AnnoShapeRect = { id: "a", kind: "rect", x: 3, y: 4, w: 10, h: 20, color: "#fff", width: 4, fill: false };
		const moved = translateElement(el, 7, 6);
		expect([moved.x, moved.y, moved.w, moved.h]).toEqual([10, 10, 10, 20]);
	});
});

describe("sanitizeAnnotationDoc（载入清洗）", () => {
	const base = { v: 1, imgW: 800, imgH: 600 };

	it("非法整体形状 → null", () => {
		expect(sanitizeAnnotationDoc(null)).toBeNull();
		expect(sanitizeAnnotationDoc("x")).toBeNull();
		expect(sanitizeAnnotationDoc({ imgW: -1, imgH: 600, elements: [] })).toBeNull();
		expect(sanitizeAnnotationDoc({ imgW: NaN, imgH: 600, elements: [] })).toBeNull();
	});

	it("坏元素丢弃、好元素保留；未知 kind 丢弃", () => {
		const doc = sanitizeAnnotationDoc({
			...base,
			elements: [
				{ id: "p1", kind: "pen", points: [0, 0, 5, 5], color: "#ff0000", width: 4 },
				{ kind: "pen", points: [0, 0, 5] },               // 奇数点列 → 丢
				{ kind: "arrow", points: [0, 0, 1, Infinity] },    // 非有限数 → 丢
				{ kind: "rect", x: 0, y: 0, w: 0, h: 10 },         // 零宽 → 丢
				{ kind: "sticker", x: 0, y: 0 },                   // 未知类型 → 丢
				{ kind: "text", x: 1, y: 2, text: "  ok  " },
				{ kind: "text", x: 1, y: 2, text: "   " },         // 空文本 → 丢
			],
		});
		expect(doc).not.toBeNull();
		expect(doc!.elements.map((e) => e.kind)).toEqual(["pen", "text"]);
		expect((doc!.elements[1] as { text: string }).text).toBe("ok");
	});

	it("非法颜色/宽度回退默认并收敛", () => {
		const doc = sanitizeAnnotationDoc({
			...base,
			elements: [{ kind: "pen", points: [0, 0, 5, 5], color: "javascript:alert(1)", width: 99999 }],
		});
		const pen = doc!.elements[0] as AnnoPen;
		expect(pen.color).toBe("#ff3b30");
		expect(pen.width).toBe(200);
	});

	it("元素数量按上限截断", () => {
		const elements = Array.from({ length: MAX_ELEMENTS + 50 }, (_, i) => ({
			kind: "text", x: i, y: 0, text: `t${i}`,
		}));
		const doc = sanitizeAnnotationDoc({ ...base, elements });
		expect(doc!.elements.length).toBe(MAX_ELEMENTS);
	});

	it("stamp：无章源（既无 builtin 也无 stampId）丢弃；dashed 只认 true", () => {
		const doc = sanitizeAnnotationDoc({
			...base,
			elements: [
				{ kind: "stamp", x: 0, y: 0, w: 10, h: 10, builtin: "person" },
				{ kind: "stamp", x: 0, y: 0, w: 10, h: 10, stampId: "st-1", dashed: "yes" },
				{ kind: "stamp", x: 0, y: 0, w: 10, h: 10 }, // 无源 → 丢
			],
		});
		expect(doc!.elements.length).toBe(2);
		expect((doc!.elements[0] as AnnoStamp).builtin).toBe("person");
		expect((doc!.elements[1] as AnnoStamp).dashed).toBeUndefined();
	});

	it("masks：坏蒙版丢弃、好蒙版保留；dashedLine 只认 true", () => {
		const doc = sanitizeAnnotationDoc({
			...base,
			elements: [{
				kind: "pen", points: [0, 0, 50, 50], color: "#f00", width: 4,
				masks: [
					{ points: [0, 0, 10, 10], width: 30 },
					{ points: [0, 0, 10, 10], width: 30, dashedLine: true },
					{ points: [0, 0, 10, 10], width: 30, dashedLine: "y" },
					{ points: [0, 0, 5], width: 30 },       // 奇数点列 → 丢
					{ points: [0, 0, 10, Infinity], width: 30 }, // 非有限数 → 丢
					"junk",
				],
			}],
		});
		const pen = doc!.elements[0] as AnnoPen;
		expect(pen.masks!.length).toBe(3);
		expect(pen.masks![0].dashedLine).toBeUndefined();
		expect(pen.masks![1].dashedLine).toBe(true);
		expect(pen.masks![2].dashedLine).toBeUndefined();
	});

	it("masks：dashScale 超界收敛；非虚线蒙版上的 dashScale 丢弃", () => {
		const doc = sanitizeAnnotationDoc({
			...base,
			elements: [{
				kind: "pen", points: [0, 0, 50, 50], color: "#f00", width: 4,
				masks: [
					{ points: [0, 0, 10, 10], width: 30, dashedLine: true, dashScale: 99 },
					{ points: [0, 0, 10, 10], width: 30, dashedLine: true, dashScale: 0.5 },
					{ points: [0, 0, 10, 10], width: 30, dashScale: 0.5 }, // 非虚线 → dashScale 无意义
				],
			}],
		});
		const pen = doc!.elements[0] as AnnoPen;
		expect(pen.masks![0].dashScale).toBe(4);   // 上限收敛
		expect(pen.masks![1].dashScale).toBe(0.5);
		expect(pen.masks![2].dashScale).toBeUndefined();
	});
});

describe("applyEraseStroke（橡皮分发为元素蒙版）", () => {
	const pen = (): AnnoPen => ({ id: "p", kind: "pen", points: [100, 100, 200, 100], color: "#f00", width: 4 });
	const far = (): AnnoShapeRect => ({ id: "r", kind: "rect", x: 500, y: 500, w: 50, h: 50, color: "#0f0", width: 3, fill: false });

	it("笔刷只分发给外接盒相交的元素；空白处返回 null", () => {
		const out = applyEraseStroke([pen(), far()], [150, 90, 150, 110], 20, false)!;
		expect(out[0].masks!.length).toBe(1);
		expect(out[1].masks).toBeUndefined();
		expect(applyEraseStroke([pen()], [400, 400, 420, 420], 20, false)).toBeNull();
	});

	it("蒙版坐标=相对元素锚点；dashedLine 标记透传", () => {
		const out = applyEraseStroke([pen()], [150, 90, 150, 110], 20, true)!;
		const m = out[0].masks![0];
		// pen 锚点 = 首点 (100,100) → 相对坐标 (50,-10)…(50,10)
		expect(m.points).toEqual([50, -10, 50, 10]);
		expect(m.dashedLine).toBe(true);
		expect(m.width).toBe(20);
	});

	it("dashScale：虚线橡皮才落盘、=1 省略、超界收敛；普通橡皮忽略", () => {
		const dashed = applyEraseStroke([pen()], [150, 90, 150, 110], 20, true, 0.5)!;
		expect(dashed[0].masks![0].dashScale).toBe(0.5);
		const unit = applyEraseStroke([pen()], [150, 90, 150, 110], 20, true, 1)!;
		expect(unit[0].masks![0].dashScale).toBeUndefined();
		const over = applyEraseStroke([pen()], [150, 90, 150, 110], 20, true, 99)!;
		expect(over[0].masks![0].dashScale).toBe(4);
		const plain = applyEraseStroke([pen()], [150, 90, 150, 110], 20, false, 0.5)!;
		expect(plain[0].masks![0].dashScale).toBeUndefined();
	});

	it("多笔叠加追加蒙版；达到上限后不再追加", () => {
		let els: ReturnType<typeof pen>[] = [pen()];
		for (let i = 0; i < MAX_MASKS_PER_ELEMENT + 5; i++) {
			const next = applyEraseStroke(els, [150 + i, 90, 150 + i, 110], 10, false);
			if (next) els = next as ReturnType<typeof pen>[];
		}
		expect(els[0].masks!.length).toBe(MAX_MASKS_PER_ELEMENT);
	});

	it("文字/纹章也能被分发（估算包围盒相交即得蒙版）", () => {
		const text = { id: "t", kind: "text", x: 0, y: 0, text: "hello", color: "#fff", fontSize: 20 } as const;
		const stamp: AnnoStamp = { id: "s", kind: "stamp", x: 300, y: 300, w: 60, h: 60, color: "#f00", width: 3, fill: true, builtin: "person" };
		const out = applyEraseStroke([text, stamp], [30, 10, 320, 320], 16, false)!;
		expect(out[0].masks!.length).toBe(1);
		expect(out[1].masks!.length).toBe(1);
		// stamp 锚点 = (x,y)=(300,300)：末点相对坐标 (20,20)
		expect(out[1].masks![0].points.slice(-2)).toEqual([20, 20]);
	});
});

describe("snapToStroke（橡皮吸附线条）", () => {
	const line = (): AnnoPen => ({ id: "L", kind: "pen", points: [0, 0, 100, 0], color: "#f00", width: 4 });

	it("半径内吸到最近线上点；半径外返回 null", () => {
		const s = snapToStroke([line()], 50, 8, 10)!;
		expect([s.x, s.y, s.elId]).toEqual([50, 0, "L"]);
		expect(snapToStroke([line()], 50, 20, 10)).toBeNull();
	});

	it("粘滞：preferId 元素在 1.4× 半径内优先，不被更近的旁线抢走", () => {
		const other: AnnoPen = { id: "M", kind: "pen", points: [0, 10, 100, 10], color: "#0f0", width: 4 };
		// 点 (50,8)：距 M 仅 2、距 L 有 8——无 prefer 时吸 M，prefer L 时粘住 L（8 ≤ 10×1.4）
		expect(snapToStroke([line(), other], 50, 8, 10)!.elId).toBe("M");
		expect(snapToStroke([line(), other], 50, 8, 10, "L")!.elId).toBe("L");
		// prefer 超出 1.4× 半径则失效，回落全局最近
		expect(snapToStroke([line(), other], 50, 25, 10, "L")).toBeNull();
	});

	it("矩形吸边框、椭圆吸轮廓；纹章/文字不参与", () => {
		const rect: AnnoShapeRect = { id: "R", kind: "rect", x: 0, y: 0, w: 100, h: 100, color: "#f00", width: 3, fill: false };
		const sr = snapToStroke([rect], 50, -6, 10)!;
		expect([sr.x, sr.y]).toEqual([50, 0]); // 上边框
		const ell: AnnoShapeRect = { id: "E", kind: "ellipse", x: 0, y: 0, w: 100, h: 100, color: "#f00", width: 3, fill: false };
		const se = snapToStroke([ell], 50, -5, 10)!;
		expect(Math.abs(se.x - 50)).toBeLessThan(0.5);
		expect(Math.abs(se.y - 0)).toBeLessThan(0.5); // 圆顶点
		const st: AnnoStamp = { id: "S", kind: "stamp", x: 40, y: -20, w: 20, h: 20, color: "#f00", width: 2, fill: false, builtin: "star" };
		expect(snapToStroke([st], 50, -10, 30)).toBeNull();
	});
});

describe("annotationXform（选中框变形：单应/四角操作）", () => {
	const rectEl = (): AnnoShapeRect => ({ id: "r", kind: "rect", x: 0, y: 0, w: 100, h: 50, color: "#f00", width: 3, fill: false });
	const BASE = [0, 0, 100, 0, 100, 50, 0, 50];

	it("baseQuadOf：几何外接四角；水平线退化维度撑到 1px 防单应奇异", () => {
		expect(baseQuadOf(rectEl())).toEqual(BASE);
		const pen: AnnoPen = { id: "p", kind: "pen", points: [0, 200, 100, 200], color: "#f00", width: 4 };
		const q = baseQuadOf(pen);
		expect(q[1]).toBeCloseTo(199.5);
		expect(q[5]).toBeCloseTo(200.5);
	});

	it("homography：平移=仿射且应用点精确；拖单角=透视（非仿射），四角精确映射", () => {
		const t = homographyFromQuads(BASE, BASE.map((v, i) => (i % 2 === 0 ? v + 10 : v + 20)))!;
		expect(isAffineH(t)).toBe(true);
		const p = applyH(t, 50, 25);
		expect(p.x).toBeCloseTo(60);
		expect(p.y).toBeCloseTo(45);
		const persp = [0, 0, 100, 10, 100, 40, 0, 50]; // 右侧收窄
		const h = homographyFromQuads(BASE, persp)!;
		expect(isAffineH(h)).toBe(false);
		for (let i = 0; i < 4; i++) {
			const q = applyH(h, BASE[i * 2], BASE[i * 2 + 1]);
			expect(q.x).toBeCloseTo(persp[i * 2]);
			expect(q.y).toBeCloseTo(persp[i * 2 + 1]);
		}
	});

	it("invertH：正逆往返回到原点", () => {
		const h = homographyFromQuads(BASE, [5, 3, 120, 8, 110, 60, -4, 52])!;
		const hi = invertH(h)!;
		const p = applyH(h, 30, 20);
		const b = applyH(hi, p.x, p.y);
		expect(b.x).toBeCloseTo(30);
		expect(b.y).toBeCloseTo(20);
	});

	it("rotateQuad 90°/flipQuad 镜像/quadCenter/quadBBox", () => {
		expect(quadCenter(BASE)).toEqual({ x: 50, y: 25 });
		const r = rotateQuad(BASE, Math.PI / 2);
		expect(r[0]).toBeCloseTo(75);
		expect(r[1]).toBeCloseTo(-25);
		const f = flipQuad(BASE, "x");
		expect(f[0]).toBeCloseTo(100);
		expect(f[2]).toBeCloseTo(0);
		expect(quadBBox(BASE)).toEqual({ x1: 0, y1: 0, x2: 100, y2: 50 });
	});

	it("withElementQuad：偏离才落 xform，回到原位自动摘除（复位语义）", () => {
		const el = rectEl();
		const moved = withElementQuad(el, [10, 0, 110, 0, 110, 50, 10, 50]);
		expect(moved.xform!.quad[0]).toBe(10);
		expect(quadOfElement(moved)[0]).toBe(10);
		const back = withElementQuad(moved, baseQuadOf(el));
		expect(back.xform).toBeUndefined();
		expect(withElementQuad(el, baseQuadOf(el))).toBe(el);
	});

	it("translateElement：xform.quad 与基准几何同步平移（相对变形不变）", () => {
		const el = withElementQuad(rectEl(), rotateQuad(BASE, Math.PI / 4));
		const t = translateElement(el, 10, 20);
		expect(t.x).toBe(10);
		expect(t.xform!.quad[0]).toBeCloseTo(el.xform!.quad[0] + 10, 1);
		expect(t.xform!.quad[1]).toBeCloseTo(el.xform!.quad[1] + 20, 1);
	});

	it("sanitize：xform 白名单——8 个有限数保留，坏 quad 整体丢弃", () => {
		const doc = sanitizeAnnotationDoc({
			v: 1, imgW: 100, imgH: 100, elements: [
				{ kind: "rect", x: 0, y: 0, w: 10, h: 10, color: "#f00", width: 3, xform: { quad: [0, 0, 10, 0, 10, 10, 0, 10] } },
				{ kind: "rect", x: 0, y: 0, w: 10, h: 10, color: "#f00", width: 3, xform: { quad: [0, 0, Infinity, 0, 10, 10, 0, 10] } },
				{ kind: "rect", x: 0, y: 0, w: 10, h: 10, color: "#f00", width: 3, xform: { quad: [1, 2, 3] } },
			],
		});
		expect(doc!.elements[0].xform!.quad.length).toBe(8);
		expect(doc!.elements[1].xform).toBeUndefined();
		expect(doc!.elements[2].xform).toBeUndefined();
	});

	it("applyEraseStroke：变形元素按显示位置（quad）判交、笔刷经逆单应存基准空间", () => {
		// 基准 0..100/0..50，quad 整体平移 +200：显示在 x=200..300
		const el = withElementQuad(rectEl(), [200, 0, 300, 0, 300, 50, 200, 50]);
		const hit = applyEraseStroke([el], [250, 10, 250, 40], 20, false)!;
		const m = hit[0].masks![0];
		expect(m.points[0]).toBeCloseTo(50); // 逆映射回基准 (50,10)
		expect(m.points[1]).toBeCloseTo(10);
		expect(m.width).toBeCloseTo(20); // 纯平移不缩放宽度
		// 笔刷落在「基准位置」（元素显示上已被移走）→ 不分发
		expect(applyEraseStroke([el], [50, 10, 50, 40], 20, false)).toBeNull();
	});

	it("snapToStroke：变形元素不参与吸附（基准几何≠显示位置）", () => {
		const pen: AnnoPen = { id: "p", kind: "pen", points: [0, 100, 200, 100], color: "#f00", width: 4 };
		const el = withElementQuad(pen, [0, 300, 200, 300, 200, 301, 0, 301]);
		expect(snapToStroke([el], 100, 100, 30)).toBeNull();
	});
});

describe("maskSpec（蒙版→destination-out 节点）", () => {
	it("常规笔刷=圆帽粗线 + destination-out；锚点回算绝对坐标；无 dash", () => {
		const spec = maskSpec({ points: [10, 0, 30, 0], width: 24 }, { x: 100, y: 50 });
		expect(spec.cls).toBe("Line");
		expect(spec.config.points).toEqual([110, 50, 130, 50]);
		expect(spec.config.globalCompositeOperation).toBe("destination-out");
		expect(spec.config.lineCap).toBe("round");
		expect(spec.config.strokeWidth).toBe(24);
		expect(spec.config.dash).toBeUndefined();
	});

	it("虚线橡皮：沿路径 dash 分段挖孔、平头防段间糊连；分段随笔刷直径有下限", () => {
		const spec = maskSpec({ points: [0, 0, 100, 0], width: 20, dashedLine: true }, { x: 0, y: 0 });
		expect(spec.config.dash).toEqual([16, 16]); // 20×0.8
		expect(spec.config.lineCap).toBe("butt");
		expect(maskDashFor(2)).toEqual([2, 2]); // 下限（防退化成实线观感）
	});

	it("dashScale 密度倍率：<1 段更短更密、>1 更疏；蒙版带 dashScale 时 maskSpec 生效", () => {
		expect(maskDashFor(20, 0.5)).toEqual([8, 8]);
		expect(maskDashFor(20, 2)).toEqual([32, 32]);
		const spec = maskSpec({ points: [0, 0, 100, 0], width: 20, dashedLine: true, dashScale: 0.5 }, { x: 0, y: 0 });
		expect(spec.config.dash).toEqual([8, 8]);
	});

	it("单点「点擦」退化为 Circle（零长圆帽线段 canvas 不出墨）", () => {
		const spec = maskSpec({ points: [5, 5, 5, 5], width: 16 }, { x: 0, y: 0 });
		expect(spec.cls).toBe("Circle");
		expect(spec.config.radius).toBe(8);
		expect(spec.config.globalCompositeOperation).toBe("destination-out");
	});
});

describe("konvaSpecFor（编辑/导出共用映射）", () => {
	it("pen → Line：tension + 圆头", () => {
		const spec = konvaSpecFor({ id: "a", kind: "pen", points: [0, 0, 5, 5], color: "#f00", width: 3 });
		expect(spec.cls).toBe("Line");
		expect(spec.config.tension).toBe(PEN_TENSION);
		expect(spec.config.lineCap).toBe("round");
	});

	it("rect：fill 开关决定是否带填充", () => {
		const el: AnnoShapeRect = { id: "a", kind: "rect", x: 0, y: 0, w: 10, h: 10, color: "#0f0", width: 2, fill: false };
		expect(konvaSpecFor(el).config.fill).toBeUndefined();
		expect(konvaSpecFor({ ...el, fill: true }).config.fill).toBe("#0f0");
	});

	it("ellipse：外接矩形换算为圆心+半径", () => {
		const spec = konvaSpecFor({ id: "a", kind: "ellipse", x: 10, y: 20, w: 40, h: 60, color: "#00f", width: 2, fill: false });
		expect(spec.cls).toBe("Ellipse");
		expect(spec.config.x).toBe(30);
		expect(spec.config.y).toBe(50);
		expect(spec.config.radiusX).toBe(20);
		expect(spec.config.radiusY).toBe(30);
	});

	it("stamp：内置章→Path 按外接矩形缩放不放大描边；PNG 章经 ctx 取图；缺图→虚线占位框", () => {
		const base: AnnoStamp = { id: "s", kind: "stamp", x: 10, y: 20, w: 50, h: 100, color: "#f00", width: 3, fill: true, builtin: "person" };
		const p = konvaSpecFor(base);
		expect(p.cls).toBe("Path");
		expect(p.config.data).toBe(BUILTIN_STAMPS.person.path);
		expect(p.config.scaleX).toBe(0.5);
		expect(p.config.scaleY).toBe(1);
		expect(p.config.strokeScaleEnabled).toBe(false);
		expect(p.config.fill).toBe("#f00");
		const fakeImg = { width: 64, height: 64 };
		const png: AnnoStamp = { ...base, builtin: undefined, stampId: "st-1" };
		const i = konvaSpecFor(png, { stampImages: { "st-1": fakeImg } });
		expect(i.cls).toBe("Image");
		expect(i.config.image).toBe(fakeImg);
		const miss = konvaSpecFor(png, { stampImages: {} });
		expect(miss.cls).toBe("Rect");
		expect(miss.config.dash).toBeTruthy();
	});

	it("虚线元素：dash 数组、笔/箭头切平头防糊点；PNG 章 dashed=半透明虚化", () => {
		const pen = konvaSpecFor({ id: "p", kind: "pen", points: [0, 0, 9, 9], color: "#fff", width: 4, dashed: true });
		expect(pen.config.dash).toEqual([12, 8]);
		expect(pen.config.lineCap).toBe("butt");
		const fakeImg = { width: 8, height: 8 };
		const png = konvaSpecFor(
			{ id: "s", kind: "stamp", x: 0, y: 0, w: 10, h: 10, color: "#fff", width: 2, fill: false, stampId: "st-1", dashed: true },
			{ stampImages: { "st-1": fakeImg } },
		);
		expect(png.config.opacity).toBe(0.45);
	});

	it("arrow：头部实心同色；text：带描影可读", () => {
		const arrow = konvaSpecFor({ id: "a", kind: "arrow", points: [0, 0, 9, 9], color: "#abc", width: 4 });
		expect(arrow.cls).toBe("Arrow");
		expect(arrow.config.fill).toBe("#abc");
		const text = konvaSpecFor({ id: "t", kind: "text", x: 0, y: 0, text: "hi", color: "#fff", fontSize: 24 });
		expect(text.cls).toBe("Text");
		expect(text.config.shadowColor).toBeTruthy();
	});
});

