/**
 * AnnotationEditor —— 图片标注编辑器（全屏遮罩，App 根经 lazy 挂载，任意界面可唤起）。
 *
 * 工具：选择 / 笔（实时绘制+鼠标停顿自动拟合平滑曲线）/ 箭头 / 矩形 / 圆（均分 无填充|有填充）
 * / 纹章（下拉选章：内置矢量章+PNG 自定义章；鼠标即预览、滚轮缩放、点击盖章）
 * / 文字 / 橡皮（**擦的是笔画不是画布**：笔刷分发为相交元素的锚点相对蒙版，destination-out
 * 挖孔露出当前位置原图；**移动元素时擦除效果跟随**）/ 虚线橡皮（沿路径方向间隔挖孔=虚线化）/ 颜色。
 * 坐标全程原图像素空间（显示按 scale 缩放）；完成时离屏 Konva.Stage 按原尺寸重绘导出合成 PNG
 * （编辑与导出共用 konvaSpecFor 映射，所见即所得）→ finishAnnotation 上传资产+落节点。
 *
 * ⚠ 图像字节一律 fetch(uri)→createImageBitmap（同源字节；asset:// 直喂 <img> 会 CORS 失败或污染
 * canvas 导致 toBlob 抛错——thumbGen/shotGroupOps 同款教训）；fetch 失败回退 <img crossOrigin>。
 * ⚠ 元素提交/擦除一律经 draftRef/elementsRef 在事件回调里完成，**绝不在 setState 更新器里做副作用**
 * （StrictMode 双调用会把元素双份提交=拖动出「残影」，首版实测踩坑；ShotGroupView 同款注释）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Konva from "konva";
import { Stage, Layer, Line, Arrow, Rect, Ellipse, Path, Group, Circle as KCircle, Image as KImage, Text as KText, Shape as KShape } from "react-konva";
import type Konva_ from "konva";
import {
    Bone, Check, ChevronDown, Circle as CircleIcon, Eraser, Heart, ImagePlus, Loader2, MousePointer2, MoveUpRight,
    PaintBucket, Pen, PersonStanding, Square, SquareDashed, Stamp as StampIcon, Star, Tags, Trash2, Type as TypeIcon, Undo2, X,
} from "lucide-react";
import { useAnnotationStore } from "@/store/annotationStore";
import { useProjectStore } from "@/store/projectStore";
import { finishAnnotation, fetchUriOf } from "@/canvas/annotate";
import { openDirectorStage } from "@/store/directorStore";
import { renderModel3dBitmap } from "@/lib/model3dRender";
import {
    applyEraseStroke, DASH_SCALE_MAX, DASH_SCALE_MIN, elementAnchor, MAX_ELEMENTS, newAnnoId, normalizedRect, simplifyPoints, snapToStroke, translateElement,
    type AnnoElement, type AnnotationDoc, type AnnoStamp, type AnnoModel3d,
} from "@/lib/annotation";
import { BUILTIN_STAMPS, konvaSpecFor, maskDashFor, maskSpec, type KonvaCls, type RenderCtx } from "@/lib/annotationRender";
import {
    baseQuadOf, flipQuad, homographyFromQuads, quadBBox, quadCenter, quadOfElement, quadScaleOf, rotateQuad, withElementQuad,
} from "@/lib/annotationXform";
import { drawWarped, quadHitFunc, renderElementSource, warpGridFor } from "@/lib/annotationWarp";
import { addCustomStamp, listCustomStamps, removeCustomStamp, type CustomStamp } from "@/lib/stampLibrary";

type Tool = "select" | "pen" | "arrow" | "rect" | "ellipse" | "stamp" | "text" | "eraser" | "dasher";

const SWATCHES = ["#ff3b30", "#ffcc00", "#34c759", "#0a84ff", "#ffffff", "#111111"];

/** 旋转区光标：双向弯箭头（SVG data-uri；四角外缘悬停/拖动时显示） */
const ROTATE_CURSOR = `url("data:image/svg+xml;utf8,${encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'>" +
    "<path d='M6.2 14.6a6.5 6.5 0 0 1 11.6-0.1' fill='none' stroke='black' stroke-width='4.4' stroke-linecap='round'/>" +
    "<path d='M6.2 14.6a6.5 6.5 0 0 1 11.6-0.1' fill='none' stroke='white' stroke-width='2.2' stroke-linecap='round'/>" +
    "<path d='M3 10.8 L9.4 12.6 L5 17.6 Z' fill='white' stroke='black' stroke-width='1.2'/>" +
    "<path d='M21 10.8 L14.6 12.6 L19 17.6 Z' fill='white' stroke='black' stroke-width='1.2'/>" +
    "</svg>",
)}") 12 12, alias`;
const BUILTIN_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
    person: PersonStanding, star: Star, heart: Heart,
};
// konvaSpecFor 的 config 是宽松 Record（编辑/导出共用），这里统一放宽组件 props 约束
const CMP: Record<KonvaCls, React.ComponentType<Record<string, unknown>>> = {
    Line: Line as unknown as React.ComponentType<Record<string, unknown>>,
    Arrow: Arrow as unknown as React.ComponentType<Record<string, unknown>>,
    Rect: Rect as unknown as React.ComponentType<Record<string, unknown>>,
    Ellipse: Ellipse as unknown as React.ComponentType<Record<string, unknown>>,
    Path: Path as unknown as React.ComponentType<Record<string, unknown>>,
    Image: KImage as unknown as React.ComponentType<Record<string, unknown>>,
    Text: KText as unknown as React.ComponentType<Record<string, unknown>>,
    Circle: KCircle as unknown as React.ComponentType<Record<string, unknown>>,
};

/** 载入图像位图：fetch 字节 → createImageBitmap；失败回退 <img crossOrigin>（shotGroupOps 同款） */
async function loadBitmap(uri: string): Promise<ImageBitmap | HTMLImageElement> {
    try {
        const resp = await fetch(uri);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return await createImageBitmap(await resp.blob());
    } catch {
        return await new Promise<HTMLImageElement>((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = "anonymous";
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error("图像加载失败"));
            img.src = uri;
        });
    }
}

const dimOf = (b: ImageBitmap | HTMLImageElement) =>
    "naturalWidth" in b ? { w: b.naturalWidth, h: b.naturalHeight } : { w: b.width, h: b.height };

/** 拖拽资产名称的自定义 MIME（区分外部文件/文本拖入，只有它才允许落到画布） */
const ASSET_NAME_MIME = "application/x-qiji-asset-name";

/** 文本宽度测量（与 Konva Text 渲染同款 bold + 默认 Arial；资产名称落画布时用于居中定位） */
let measureCtx: CanvasRenderingContext2D | null = null;
function measureTextWidth(text: string, fontSize: number): number {
    if (!measureCtx) measureCtx = document.createElement("canvas").getContext("2d");
    if (!measureCtx) return text.length * fontSize;
    measureCtx.font = `bold ${fontSize}px Arial`;
    return measureCtx.measureText(text).width;
}

/** 离屏按原尺寸重绘导出合成 PNG（编辑与导出共用 konvaSpecFor，一处映射两处生效；同步 draw 不依赖 rAF） */
async function exportComposite(img: ImageBitmap | HTMLImageElement, doc: AnnotationDoc, ctx: RenderCtx): Promise<Blob> {
    const holder = document.createElement("div");
    holder.style.display = "none";
    document.body.appendChild(holder);
    try {
        const stage = new Konva.Stage({ container: holder, width: doc.imgW, height: doc.imgH });
        const layer = new Konva.Layer({ listening: false });
        stage.add(layer);
        layer.add(new Konva.Image({ image: img, width: doc.imgW, height: doc.imgH }));
        const ctors = { Line: Konva.Line, Arrow: Konva.Arrow, Rect: Konva.Rect, Ellipse: Konva.Ellipse, Path: Konva.Path, Image: Konva.Image, Text: Konva.Text, Circle: Konva.Circle } as const;
        for (const el of doc.elements) {
            if (el.xform) {
                // 变形元素：与编辑器同一条 源画布+单应网格贴图 管线（蒙版已含在源里）
                const h = homographyFromQuads(baseQuadOf(el), el.xform.quad);
                const src = h ? renderElementSource(el, ctx, Math.min(2.5, Math.max(1, quadScaleOf(el)))) : null;
                if (h && src) {
                    layer.add(new Konva.Shape({ listening: false, sceneFunc: (c) => drawWarped(c, src, h, warpGridFor(h, src.rect)) }));
                    continue;
                }
                // 退化单应回退基准渲染（与编辑器一致，不让内容消失）
            }
            const spec = konvaSpecFor(el, ctx);
            if (el.masks?.length) {
                // 带擦除蒙版的元素：隔离组 cache 后 destination-out 只挖本元素（与编辑器同构）
                const g = new Konva.Group({ listening: false });
                g.add(new ctors[spec.cls](spec.config as never));
                const anchor = elementAnchor(el);
                for (const m of el.masks) {
                    const ms = maskSpec(m, anchor);
                    g.add(new ctors[ms.cls](ms.config as never));
                }
                layer.add(g);
                g.cache({ pixelRatio: 1 });
                continue;
            }
            layer.add(new ctors[spec.cls](spec.config as never));
        }
        layer.draw();
        const canvas = stage.toCanvas({ pixelRatio: 1 });
        const blob = await new Promise<Blob>((resolve, reject) =>
            canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("导出失败（图像可能跨域污染）"))), "image/png"),
        );
        stage.destroy();
        return blob;
    } finally {
        holder.remove();
    }
}

/**
 * 带擦除蒙版的元素：Group 隔离 + cache（rasterize）后 destination-out 只挖本元素——
 * 挖掉的部分透出**当前位置**的原图（颜色随位置变化）；蒙版是锚点相对坐标，拖动元素时
 * 擦除效果自动跟随（用户核心诉求）。⚠ 不 cache 的话 destination-out 会把整层挖穿。
 */
function MaskedNode(props: {
    el: AnnoElement;
    renderCtx: RenderCtx;
    scale: number;
    selected: boolean;
    interactive: boolean;
    onSelect: () => void;
    onDblClick: () => void;
    onDragEnd: (dx: number, dy: number, alt: boolean) => void;
}) {
    const { el, renderCtx, scale } = props;
    const ref = useRef<Konva_.Group>(null);
    const altRef = useRef(false); // 拖动起手是否按着 Alt（=复制而非移动）
    useEffect(() => {
        const n = ref.current;
        if (!n) return;
        // 每次渲染后重建缓存（元素/蒙版/缩放变了缓存即过期）；分辨率跟显示缩放，上限 3 防大图爆内存
        n.cache({ pixelRatio: Math.min(3, Math.max(1, scale)) });
        n.getLayer()?.batchDraw();
    });
    const spec = konvaSpecFor(el, renderCtx);
    const C = CMP[spec.cls];
    const anchor = elementAnchor(el);
    return (
        <Group ref={ref} listening={props.interactive} draggable={props.interactive}
            {...(props.selected ? { shadowColor: "#22d3ee", shadowBlur: 14 / scale, shadowOpacity: 1 } : {})}
            onMouseDown={(e: Konva_.KonvaEventObject<MouseEvent>) => { e.cancelBubble = true; props.onSelect(); }}
            onDblClick={props.onDblClick}
            onDragStart={(e: Konva_.KonvaEventObject<DragEvent>) => { altRef.current = e.evt.altKey; }}
            onDragEnd={(e: Konva_.KonvaEventObject<DragEvent>) => {
                const dx = e.target.x();
                const dy = e.target.y();
                e.target.position({ x: 0, y: 0 });
                if (dx !== 0 || dy !== 0) props.onDragEnd(dx, dy, altRef.current);
            }}>
            <C {...spec.config} />
            {(el.masks ?? []).map((m, i) => {
                const ms = maskSpec(m, anchor);
                const MC = CMP[ms.cls];
                return <MC key={i} {...ms.config} />;
            })}
        </Group>
    );
}

/**
 * WarpNode —— 带 xform（旋转/翻转/透视）的元素：离屏渲染成源画布后按单应矩阵网格贴图
 * （[annotationWarp.ts](../lib/annotationWarp.ts)；仿射 1 格精确、透视细分网格）。
 * 命中区=显示四角多边形（quadHitFunc），拖动/选择/双击行为与普通元素一致；
 * 蒙版包含在源画布里随整组一起变形。退化单应（四角拖成一条线）回退基准渲染防消失。
 */
function WarpNode(props: {
    el: AnnoElement;
    quad: number[];
    renderCtx: RenderCtx;
    scale: number;
    selected: boolean;
    interactive: boolean;
    onSelect: () => void;
    onDblClick: () => void;
    onDragEnd: (dx: number, dy: number, alt: boolean) => void;
}) {
    const { el, quad, renderCtx, scale } = props;
    const altRef = useRef(false);
    // 源画布缓存键：元素内容（几何/样式/蒙版）——xform 变化不重绘源，只换贴图矩阵
    const srcKey = useMemo(() => JSON.stringify({ ...el, xform: undefined }), [el]);
    // 分辨率：显示缩放 × 变形放大量（0.5 档位化防拖动手柄时频繁重渲染源）
    const prB = useMemo(() => {
        const s = Math.max(1, quadScaleOf(el));
        return Math.min(3, Math.max(1, Math.ceil(scale * s * 2) / 2));
    }, [el, scale]);
    const source = useMemo(
        () => renderElementSource(el, renderCtx, prB),
        [srcKey, renderCtx, prB], // eslint-disable-line react-hooks/exhaustive-deps
    );
    const h = useMemo(() => homographyFromQuads(baseQuadOf(el), quad), [srcKey, quad]); // eslint-disable-line react-hooks/exhaustive-deps
    if (!source || !h) {
        const spec = konvaSpecFor(el, renderCtx);
        const C = CMP[spec.cls];
        return <C {...spec.config} listening={false} />;
    }
    const grid = warpGridFor(h, source.rect);
    // stroke/strokeWidth 只喂给 hitFunc 的 fillStrokeShape 扩命中带——细线/箭头的几何四边形
    // 高度趋近 0，不加描边带点不中（sceneFunc 全自定义绘制，不会真画出这圈描边）
    const hitPad = Math.max(14 / scale, ("width" in el && typeof el.width === "number" ? el.width * 2 : 0));
    return (
        <KShape listening={props.interactive} draggable={props.interactive} fill="#000"
            stroke="#000" strokeWidth={hitPad}
            sceneFunc={(ctx: Konva_.Context) => drawWarped(ctx, source, h, grid)}
            hitFunc={quadHitFunc(quad)}
            {...(props.selected ? { shadowColor: "#22d3ee", shadowBlur: 14 / scale, shadowOpacity: 1 } : {})}
            onMouseDown={(e: Konva_.KonvaEventObject<MouseEvent>) => { e.cancelBubble = true; props.onSelect(); }}
            onDblClick={props.onDblClick}
            onDragStart={(e: Konva_.KonvaEventObject<DragEvent>) => { altRef.current = e.evt.altKey; }}
            onDragEnd={(e: Konva_.KonvaEventObject<DragEvent>) => {
                const dx = e.target.x();
                const dy = e.target.y();
                e.target.position({ x: 0, y: 0 });
                if (dx !== 0 || dy !== 0) props.onDragEnd(dx, dy, altRef.current);
            }} />
    );
}

export default function AnnotationEditor() {
    const session = useAnnotationStore((s) => s.session);
    const close = useAnnotationStore((s) => s.close);
    // 项目五类资产（资产名称下拉的数据源；只取有名字的）
    const pjCharacters = useProjectStore((s) => s.characters);
    const pjCrowds = useProjectStore((s) => s.crowds);
    const pjScenes = useProjectStore((s) => s.scenes);
    const pjOrganisms = useProjectStore((s) => s.organisms);
    const pjItems = useProjectStore((s) => s.items);
    const assetGroups = useMemo(() =>
        [
            { label: "角色", list: pjCharacters },
            { label: "群像", list: pjCrowds },
            { label: "场景", list: pjScenes },
            { label: "生物", list: pjOrganisms },
            { label: "物品", list: pjItems },
        ]
            .map((g) => ({ label: g.label, names: g.list.map((a) => a.name.trim()).filter(Boolean) }))
            .filter((g) => g.names.length > 0),
    [pjCharacters, pjCrowds, pjScenes, pjOrganisms, pjItems]);

    const [bitmap, setBitmap] = useState<ImageBitmap | HTMLImageElement | null>(null);
    const [loadErr, setLoadErr] = useState<string | null>(null);
    const [elements, setElements] = useState<AnnoElement[]>([]);
    const [draft, setDraft] = useState<AnnoElement | null>(null);
    const [tool, setTool] = useState<Tool>("pen");
    const [color, setColor] = useState(SWATCHES[0]);
    const [sizeIdx, setSizeIdx] = useState(1); // 0细 1中 2粗
    const [fillOn, setFillOn] = useState(false);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [textEdit, setTextEdit] = useState<{ x: number; y: number; value: string; id?: string } | null>(null);
    const [saving, setSaving] = useState(false);
    const [viewport, setViewport] = useState({ w: window.innerWidth, h: window.innerHeight });
    // 资产名称下拉（快速把资产名当文字落到画面）
    const [assetPanel, setAssetPanel] = useState(false);
    // 纹章：章库面板 / 选中章 / 指针预览位置 / 缩放（相对原图短边的高度占比）
    const [stampPanel, setStampPanel] = useState(false);
    const [customStamps, setCustomStamps] = useState<CustomStamp[]>([]);
    const [activeStamp, setActiveStamp] = useState<{ builtin?: string; stampId?: string; name: string } | null>(null);
    const [stampPtr, setStampPtr] = useState<{ x: number; y: number } | null>(null);
    const [stampScale, setStampScale] = useState(0.18);
    const [stampVer, setStampVer] = useState(0); // PNG 章图像异步加载完成后 bump 触发重渲染
    // 橡皮/虚线橡皮的在绘笔刷（绝对坐标）：层顶 destination-out 即时挖孔预览，松手分发为元素蒙版
    const [eraseDraft, setEraseDraft] = useState<{ points: number[]; width: number; dashedLine: boolean } | null>(null);
    // 虚线橡皮的虚线密度倍率（滚轮调节，涂抹中也可调；ref 供松手结算读最新值）
    const [dashScale, setDashScale] = useState(1);
    const dashScaleRef = useRef(1);
    dashScaleRef.current = dashScale;
    // 选中框变形的在拖草稿（四角/旋转拖动中实时渲染，松手 withElementQuad 落定）
    const [xformDraft, setXformDraft] = useState<{ id: string; quad: number[] } | null>(null);
    const altDragRef = useRef(false); // 普通元素拖动起手的 Alt 状态（Alt+拖动=复制）
    // 指针悬停在四角外缘旋转区（光标切换为双向弯箭头；旋转拖动期间保持）
    const [rotHover, setRotHover] = useState(false);

    const stageWrapRef = useRef<HTMLDivElement>(null);
    const textAreaRef = useRef<HTMLTextAreaElement>(null);
    const stampFileRef = useRef<HTMLInputElement>(null);
    const histRef = useRef<AnnoElement[][]>([]); // 撤销栈（元素数组快照，上限 60）
    const dirtyRef = useRef(false);
    // ⚠ 事件回调里的权威数据源（state 仅供渲染）：拖动/擦除高频回调读 ref 不读闭包 state，
    // 提交也从 ref 出发——绝不在 setState 更新器里嵌 setState（StrictMode 双调用=元素双份「残影」）。
    const elementsRef = useRef<AnnoElement[]>(elements);
    elementsRef.current = elements;
    const draftRef = useRef<AnnoElement | null>(null);
    /** PNG 章图像缓存：stampId → 位图（编辑渲染与导出共用） */
    const stampImagesRef = useRef<Record<string, ImageBitmap | HTMLImageElement>>({});
    // 绘制会话（window 级 move/up 跟踪，超出画布边缘不断线）
    const drawRef = useRef<{ lastMoveAt: number; pauseFitted: boolean; pauseTimer: number } | null>(null);

    const setDraftBoth = (d: AnnoElement | null) => { draftRef.current = d; setDraft(d); };

    /** 载入一枚 PNG 章的位图进缓存（幂等；完成 bump stampVer 重渲染） */
    const ensureStampImage = useCallback((stampId: string, dataUrl: string) => {
        if (stampImagesRef.current[stampId]) return;
        void loadBitmap(dataUrl).then((img) => {
            stampImagesRef.current[stampId] = img;
            setStampVer((v) => v + 1);
        }).catch(() => {});
    }, []);

    /** 3D 模型层位图缓存：元素 id → 离屏重渲的透明位图（doc 只存场景 JSON，位图现渲；
     *  签名级缓存在 model3dRender 内部——同一场景反复进出编辑器不重复渲）。 */
    const model3dImagesRef = useRef<Record<string, ImageBitmap>>({});
    const model3dGlbResolver = useCallback(async (assetId: string): Promise<ArrayBuffer | null> => {
        try {
            const uri = fetchUriOf(assetId);
            return uri ? await (await fetch(uri)).arrayBuffer() : null;
        } catch { return null; }
    }, []);
    const ensureModel3dImage = useCallback((el: AnnoModel3d) => {
        void renderModel3dBitmap(el, model3dGlbResolver).then((bmp) => {
            if (!bmp) return;
            model3dImagesRef.current[el.id] = bmp;
            setStampVer((v) => v + 1); // 复用重渲信号（renderCtx 随之重建）
        });
    }, [model3dGlbResolver]);

    // ── 会话开合：载图 / 还原既有矢量 / 复位工具态 / 预载 doc 里引用的 PNG 章 ──
    useEffect(() => {
        if (!session) return;
        const initial = session.doc?.elements ?? [];
        setBitmap(null);
        setLoadErr(null);
        setElements(initial);
        elementsRef.current = initial;
        setDraftBoth(null);
        setSelectedId(null);
        setTextEdit(null);
        setSaving(false);
        setTool("pen");
        setAssetPanel(false);
        setStampPanel(false);
        setActiveStamp(null);
        setStampPtr(null);
        setEraseDraft(null);
        setDashScale(1);
        setXformDraft(null);
        setRotHover(false);
        histRef.current = [];
        dirtyRef.current = false;
        const lib = listCustomStamps();
        setCustomStamps(lib);
        for (const el of initial) {
            if (el.kind === "stamp" && el.stampId) {
                const hit = lib.find((s) => s.id === el.stampId);
                if (hit) ensureStampImage(hit.id, hit.dataUrl);
            }
            if (el.kind === "model3d") ensureModel3dImage(el); // 再编辑：3D 层位图离屏重渲
        }
        let alive = true;
        loadBitmap(session.source.uri)
            .then((b) => { if (alive) setBitmap(b); })
            .catch((e) => { if (alive) setLoadErr(e instanceof Error ? e.message : "图像加载失败"); });
        const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
        window.addEventListener("resize", onResize);
        return () => { alive = false; window.removeEventListener("resize", onResize); };
    }, [session, ensureStampImage]);

    // 文字输入浮层：挂载后强制夺焦（mousedown 已 preventDefault，焦点不会被画布抢回；
    // autoFocus 在「mousedown 同拍新建元素」场景下不可靠——真机「无法输入」的根因）
    useEffect(() => {
        if (!textEdit) return;
        const t = window.setTimeout(() => {
            textAreaRef.current?.focus();
            textAreaRef.current?.select();
        }, 0);
        return () => window.clearTimeout(t);
    }, [textEdit?.x, textEdit?.y, textEdit?.id]); // eslint-disable-line react-hooks/exhaustive-deps

    const dims = bitmap ? dimOf(bitmap) : null;
    const minDim = dims ? Math.min(dims.w, dims.h) : 1000;
    // 线宽/字号按原图短边取比例（导出到原尺寸时观感稳定），三档
    const strokeW = useMemo(() => {
        const base = [0.004, 0.008, 0.015][sizeIdx] * minDim;
        return Math.max([2, 3.5, 6][sizeIdx], Math.round(base * 10) / 10);
    }, [sizeIdx, minDim]);
    const fontSize = useMemo(() => Math.max(16, Math.round(minDim * [0.03, 0.045, 0.07][sizeIdx])), [sizeIdx, minDim]);
    // 适配缩放：留出顶部工具栏(56)与四周边距
    const scale = dims ? Math.min((viewport.w - 48) / dims.w, (viewport.h - 56 - 40) / dims.h, 3) : 1;
    // 渲染上下文：PNG 章位图查找表（stampVer 变化即重建，异步载图完成后画面自动补上）
    const renderCtx = useMemo<RenderCtx>(() => ({
        stampImages: { ...stampImagesRef.current },
        model3dImages: { ...model3dImagesRef.current },
    }), [stampVer]); // eslint-disable-line react-hooks/exhaustive-deps

    // 滚轮（native 非 passive：React onWheel 在根是 passive，preventDefault 无效——Lightbox 同款）：
    // 纹章工具=缩放章的尺寸；虚线橡皮=调虚线密度（上滚更密、下滚更疏，涂抹中实时生效）
    useEffect(() => {
        const el = stageWrapRef.current;
        if (!el || (tool !== "stamp" && tool !== "dasher")) return;
        const onWheel = (e: WheelEvent) => {
            e.preventDefault();
            e.stopPropagation();
            if (tool === "stamp") setStampScale((v) => Math.min(1.5, Math.max(0.04, v * Math.exp(-e.deltaY * 0.0012))));
            else setDashScale((v) => Math.min(DASH_SCALE_MAX, Math.max(DASH_SCALE_MIN, v * Math.exp(e.deltaY * 0.001))));
        };
        el.addEventListener("wheel", onWheel, { passive: false });
        return () => el.removeEventListener("wheel", onWheel);
    }, [tool, bitmap]);

    /** 撤销栈快照（提交/擦除/拖动前调，读 ref 权威值） */
    const snapshot = useCallback(() => {
        histRef.current.push(elementsRef.current);
        if (histRef.current.length > 60) histRef.current.shift();
        dirtyRef.current = true;
    }, []);

    /** 元素提交唯一入口：快照 + 按 id 去重追加（防任何重复路径产生「残影」） */
    const commitElement = useCallback((el: AnnoElement) => {
        snapshot();
        setElements((els) => (els.some((x) => x.id === el.id) ? els : [...els, el]));
    }, [snapshot]);

    const undo = useCallback(() => {
        const prev = histRef.current.pop();
        if (prev) { setElements(prev); setSelectedId(null); }
    }, []);

    const deleteSelected = useCallback(() => {
        if (!selectedId) return;
        snapshot();
        setElements((els) => els.filter((e) => e.id !== selectedId));
        setSelectedId(null);
    }, [selectedId, snapshot]);

    /** 选中框变形落定：quad 写回元素（回到原位自动摘除 xform=复位） */
    const applyQuad = useCallback((id: string, quad: number[]) => {
        snapshot();
        setElements((els) => els.map((x) => (x.id === id ? withElementQuad(x, quad) : x)));
    }, [snapshot]);

    /** 拖动落定：普通移动 / Alt+拖动=原元素不动、落一份平移后的副本 */
    const moveOrCopy = useCallback((el: AnnoElement, dx: number, dy: number, alt: boolean) => {
        if (alt) {
            if (elementsRef.current.length >= MAX_ELEMENTS) { alert(`涂鸦元素已达上限 ${MAX_ELEMENTS}`); return; }
            commitElement({ ...translateElement(el, dx, dy), id: newAnnoId() });
            return;
        }
        snapshot();
        setElements((els) => els.map((x) => (x.id === el.id ? translateElement(x, dx, dy) : x)));
    }, [commitElement, snapshot]);

    /** 3D 模型层：打开 3D 导演台（底图=当前原图；editEl=再编辑）。完成回调把
     *  透明模型层位图+场景 JSON 交回——doc 只存场景（零位图），位图入本地缓存。 */
    const open3dStage = useCallback((editEl?: AnnoModel3d) => {
        if (!session || !dims) return;
        openDirectorStage({
            mode: "image",
            uri: session.source.uri,
            name: session.source.name,
            scene: editEl?.scene,
            camera: editEl?.camera,
            embed: {
                width: dims.w,
                height: dims.h,
                onDone: ({ blob, scene, camera }) => {
                    void createImageBitmap(blob).then((bmp) => {
                        if (editEl) {
                            snapshot();
                            model3dImagesRef.current[editEl.id] = bmp;
                            setElements((els) => els.map((x) => (x.id === editEl.id ? { ...editEl, scene, camera } : x)));
                        } else {
                            const el: AnnoModel3d = { id: newAnnoId(), kind: "model3d", x: 0, y: 0, w: dims.w, h: dims.h, scene, camera };
                            model3dImagesRef.current[el.id] = bmp;
                            commitElement(el);
                            setTool("select");
                            setSelectedId(el.id);
                        }
                        setStampVer((v) => v + 1);
                    });
                },
            },
        });
    }, [session, dims, commitElement, snapshot]); // eslint-disable-line react-hooks/exhaustive-deps

    /** 选中框手柄拖动（mode=0..3 四角透视 / "rotate" 绕质心旋转）：window 级跟踪、松手落定 */
    const startQuadHandle = (el: AnnoElement, mode: number | "rotate", e: Konva_.KonvaEventObject<MouseEvent>) => {
        e.cancelBubble = true;
        e.evt.preventDefault();
        const rect = stageWrapRef.current!.getBoundingClientRect();
        // 变形手柄不夹取图内：四角/旋转允许越出图边（画面在图外的部分导出时自然裁掉）
        const toImg = (cx: number, cy: number) => ({ x: (cx - rect.left) / scale, y: (cy - rect.top) / scale });
        const startQuad = quadOfElement(el);
        const center = quadCenter(startQuad);
        const p0 = toImg(e.evt.clientX, e.evt.clientY);
        const a0 = Math.atan2(p0.y - center.y, p0.x - center.x);
        let cur = startQuad.slice();
        if (mode === "rotate") setRotHover(true); // 拖出旋转区光标也不跳变
        const onMove = (me: MouseEvent) => {
            const q = toImg(me.clientX, me.clientY);
            if (mode === "rotate") {
                const a = Math.atan2(q.y - center.y, q.x - center.x);
                cur = rotateQuad(startQuad, a - a0, center);
            } else {
                cur = startQuad.slice();
                cur[mode * 2] = q.x;
                cur[mode * 2 + 1] = q.y;
            }
            setXformDraft({ id: el.id, quad: cur });
        };
        const onUp = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
            setXformDraft(null);
            if (mode === "rotate") setRotHover(false);
            if (cur.some((v, i) => Math.abs(v - startQuad[i]) > 0.01)) applyQuad(el.id, cur);
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
    };

    const requestClose = useCallback(() => {
        if (saving) return;
        if (dirtyRef.current && !window.confirm("放弃本次涂鸦修改？")) return;
        close();
    }, [saving, close]);

    // ── 键盘：Esc 取消 / Ctrl+Z 撤销 / Delete 删所选（capture 拦截，避免触发画布快捷键） ──
    useEffect(() => {
        if (!session) return;
        const onKey = (e: KeyboardEvent) => {
            const typing = (e.target as HTMLElement)?.tagName === "TEXTAREA" || (e.target as HTMLElement)?.tagName === "INPUT";
            if (e.key === "Escape") {
                e.stopPropagation();
                if (textEdit) { setTextEdit(null); return; }
                if (stampPanel) { setStampPanel(false); return; }
                if (assetPanel) { setAssetPanel(false); return; }
                requestClose();
                return;
            }
            if (typing) return;
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); e.stopPropagation(); undo(); return; }
            if (e.key === "Delete" || e.key === "Backspace") { e.stopPropagation(); deleteSelected(); }
        };
        window.addEventListener("keydown", onKey, { capture: true });
        return () => window.removeEventListener("keydown", onKey, { capture: true });
    }, [session, textEdit, stampPanel, assetPanel, requestClose, undo, deleteSelected]);

    // ── 文字提交（新建或改所选文字）。⚠ 平铺在事件处理器里做，textEdit 走依赖保持新鲜——
    // 不用「setTextEdit 更新器内挂微任务」的写法（更新器会被 StrictMode 双调用=文字双份提交）。
    const commitText = useCallback(() => {
        const te = textEdit;
        if (!te) return;
        setTextEdit(null);
        const value = te.value.trim();
        if (!value) return;
        if (te.id) {
            snapshot();
            setElements((els) => els.map((e) => (e.id === te.id && e.kind === "text" ? { ...e, text: value } : e)));
        } else {
            commitElement({ id: newAnnoId(), kind: "text", x: te.x, y: te.y, text: value, color, fontSize });
        }
    }, [textEdit, color, fontSize, snapshot, commitElement]);

    /** 资产名称落画布：本质是文字元素（点击=画面中心 / 拖放=指定位置，均按文本中心对位），
     *  落完切「选择」工具并选中，方便立刻拖动调位。 */
    const placeAssetName = useCallback((name: string, at?: { x: number; y: number }) => {
        if (!dims) return;
        if (elementsRef.current.length >= MAX_ELEMENTS) { alert(`涂鸦元素已达上限 ${MAX_ELEMENTS}`); return; }
        const w = measureTextWidth(name, fontSize);
        const cx = at?.x ?? dims.w / 2;
        const cy = at?.y ?? dims.h / 2;
        const id = newAnnoId();
        commitElement({
            id, kind: "text",
            x: Math.max(0, Math.min(dims.w - w, cx - w / 2)),
            y: Math.max(0, Math.min(dims.h - fontSize, cy - fontSize / 2)),
            text: name, color, fontSize,
        });
        setTool("select");
        setSelectedId(id);
        setStampPanel(false);
    }, [dims, fontSize, color, commitElement]);

    // ── 橡皮/虚线橡皮：涂时**半透明红色笔刷带**预览（含吸附修正后的真实路径），松手结算——
    // applyEraseStroke 把笔刷按锚点相对坐标分发为各相交元素的蒙版（移动元素时擦除跟随）。
    // 吸附：指针落在线条（笔/箭头/矩形边框/椭圆轮廓）附近时自动吸到线上（粘滞在同一条线），
    // 沿线擦除时路径被修正得干净利落 ──
    const startEraseStroke = (dashedLine: boolean, toImg: (cx: number, cy: number) => { x: number; y: number }, p0raw: { x: number; y: number }) => {
        const width = (2 * [10, 16, 24][sizeIdx]) / scale; // 笔刷直径跟随粗细档（原图像素）
        const snapR = width * 0.75;
        let snapId: string | null = null;
        const snapPt = (q: { x: number; y: number }) => {
            const s = snapToStroke(elementsRef.current, q.x, q.y, snapR, snapId);
            if (s) { snapId = s.elId; return { x: s.x, y: s.y }; }
            return q;
        };
        const p0 = snapPt(p0raw);
        const pts: number[] = [p0.x, p0.y, p0.x, p0.y];
        setEraseDraft({ points: [...pts], width, dashedLine });
        const onMove = (me: MouseEvent) => {
            const q = snapPt(toImg(me.clientX, me.clientY));
            const n = pts.length;
            if (Math.hypot(q.x - pts[n - 2], q.y - pts[n - 1]) * scale < 1.5) return; // 抖动过滤
            pts.push(q.x, q.y);
            setEraseDraft({ points: [...pts], width, dashedLine });
        };
        const onUp = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
            setEraseDraft(null);
            const next = applyEraseStroke(elementsRef.current, simplifyPoints(pts, 1.2 / scale), width, dashedLine, dashScaleRef.current);
            if (next) {
                snapshot(); // snapshot 读 elementsRef=分发前状态
                elementsRef.current = next;
                setElements(next);
                setSelectedId(null);
            }
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
    };

    /** 当前章的宽高比（PNG 章按位图实际比例，矢量章 1:1）与指定位置的落章元素 */
    const stampElementAt = (p: { x: number; y: number }): AnnoStamp | null => {
        if (!activeStamp) return null;
        let aspect = 1;
        if (activeStamp.stampId) {
            const img = stampImagesRef.current[activeStamp.stampId];
            if (!img) return null; // 位图未就绪不落章（预览也画不出来）
            const d = dimOf(img);
            aspect = d.w > 0 && d.h > 0 ? d.w / d.h : 1;
        }
        const h = stampScale * minDim;
        const w = h * aspect;
        return {
            id: newAnnoId(), kind: "stamp",
            x: p.x - w / 2, y: p.y - h / 2, w, h,
            color, width: strokeW, fill: fillOn,
            builtin: activeStamp.builtin, stampId: activeStamp.stampId,
        };
    };

    // ── 绘制（window 级跟踪：超出边缘不断线；笔停顿 350ms 自动拟合平滑曲线） ──
    const beginDraw = (e: React.MouseEvent) => {
        if (!dims || saving || e.button !== 0) return;
        // 阻掉 mousedown 默认行为：不抢文字输入框焦点、不触发原生选区拖拽
        e.preventDefault();
        if (textEdit) { commitText(); return; }
        // ⚠ 选择工具的「点空白取消选中」在 Stage onMouseDown 里做（元素/手柄 cancelBubble 拦得住
        // Konva 冒泡拦不住 DOM 冒泡——在这里清会把刚点选的元素又清掉）
        if (tool === "select") return;
        const rect = stageWrapRef.current!.getBoundingClientRect();
        const toImg = (cx: number, cy: number) => ({
            x: Math.max(0, Math.min(dims.w, (cx - rect.left) / scale)),
            y: Math.max(0, Math.min(dims.h, (cy - rect.top) / scale)),
        });
        const p = toImg(e.clientX, e.clientY);
        if (tool === "text") {
            setTextEdit({ x: p.x, y: p.y, value: "" });
            return;
        }
        if (tool === "eraser" || tool === "dasher") {
            startEraseStroke(tool === "dasher", toImg, p);
            return;
        }
        if (elementsRef.current.length >= MAX_ELEMENTS) { alert(`涂鸦元素已达上限 ${MAX_ELEMENTS}`); return; }
        if (tool === "stamp") {
            // 盖章：点击即确认（预览已随指针显示）
            const st = stampElementAt(p);
            if (st) commitElement(st);
            else if (!activeStamp) setStampPanel(true); // 没选章就点画布 → 打开章库引导选章
            return;
        }
        const id = newAnnoId();
        const base = { id, color, width: strokeW };
        const start = p;
        const first: AnnoElement =
            tool === "pen" ? { ...base, kind: "pen", points: [p.x, p.y, p.x, p.y] }
            : tool === "arrow" ? { ...base, kind: "arrow", points: [p.x, p.y, p.x, p.y] }
            : { ...base, kind: tool, x: p.x, y: p.y, w: 1, h: 1, fill: fillOn };
        setDraftBoth(first);
        const sess = { lastMoveAt: performance.now(), pauseFitted: false, pauseTimer: 0 };
        drawRef.current = sess;
        // 笔的「停顿转曲线」：120ms 巡检，停顿 >350ms 把当前笔画 RDP 简化一次（渲染 tension 即成平滑曲线）
        if (tool === "pen") {
            sess.pauseTimer = window.setInterval(() => {
                const d = draftRef.current;
                if (sess.pauseFitted || performance.now() - sess.lastMoveAt < 350) return;
                if (d && d.kind === "pen" && d.points.length > 8) {
                    sess.pauseFitted = true;
                    setDraftBoth({ ...d, points: simplifyPoints(d.points, 2 / scale) });
                }
            }, 120);
        }

        const onMove = (me: MouseEvent) => {
            const d = draftRef.current;
            if (!d) return;
            const q = toImg(me.clientX, me.clientY);
            sess.lastMoveAt = performance.now();
            if (d.kind === "pen") {
                const n = d.points.length;
                // 抖动过滤：与上一点距离 >1.5 屏幕像素才记点
                if (Math.hypot(q.x - d.points[n - 2], q.y - d.points[n - 1]) * scale < 1.5) return;
                sess.pauseFitted = false;
                setDraftBoth({ ...d, points: [...d.points, q.x, q.y] });
            } else if (d.kind === "arrow") {
                setDraftBoth({ ...d, points: [start.x, start.y, q.x, q.y] });
            } else if (d.kind === "rect" || d.kind === "ellipse") {
                setDraftBoth({ ...d, ...normalizedRect(start.x, start.y, q.x, q.y) });
            }
        };
        const onUp = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
            if (sess.pauseTimer) window.clearInterval(sess.pauseTimer);
            drawRef.current = null;
            const d = draftRef.current;
            setDraftBoth(null);
            if (!d) return;
            // 落定校验：太小的误触（点一下没拖动）不落元素
            const tooSmall =
                d.kind === "pen" ? d.points.length < 6
                : d.kind === "arrow" ? Math.hypot(d.points[2] - d.points[0], d.points[3] - d.points[1]) < 3 / scale
                : d.kind === "rect" || d.kind === "ellipse" ? d.w < 3 / scale || d.h < 3 / scale
                : false;
            if (tooSmall) return;
            commitElement(d.kind === "pen" ? { ...d, points: simplifyPoints(d.points, 1.2 / scale) } : d);
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
    };

    /** 纹章预览跟随指针（仅 stamp 工具；坐标换算与 beginDraw 同尺） */
    const onWrapMouseMove = (e: React.MouseEvent) => {
        if (tool !== "stamp" || !dims) return;
        const rect = e.currentTarget.getBoundingClientRect();
        setStampPtr({
            x: Math.max(0, Math.min(dims.w, (e.clientX - rect.left) / scale)),
            y: Math.max(0, Math.min(dims.h, (e.clientY - rect.top) / scale)),
        });
    };

    /** 选择 PNG 文件加入章库并选中 */
    const onPickStampFile = (file: File | null) => {
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            const dataUrl = typeof reader.result === "string" ? reader.result : "";
            const r = addCustomStamp(file.name.replace(/\.[a-z0-9]+$/i, ""), dataUrl);
            if (r.error || !r.stamp) { alert(r.error || "添加失败"); return; }
            setCustomStamps(listCustomStamps());
            ensureStampImage(r.stamp.id, r.stamp.dataUrl);
            setActiveStamp({ stampId: r.stamp.id, name: r.stamp.name });
            setTool("stamp");
            setStampPanel(false);
        };
        reader.readAsDataURL(file);
    };

    // ── 完成：导出合成 → 上传/落节点（annotate.finishAnnotation） ──
    const onFinish = async () => {
        if (!session || !bitmap || !dims || saving) return;
        if (elements.length === 0) { alert("还没有任何涂鸦内容"); return; }
        setSaving(true);
        try {
            const doc: AnnotationDoc = { v: 1, imgW: dims.w, imgH: dims.h, elements };
            // 3D 模型层位图若未就绪（三方库慢/首次重渲中）：导出前补渲一次，仍失败才跳过
            for (const el of elements) {
                if (el.kind === "model3d" && !model3dImagesRef.current[el.id]) {
                    const bmp = await renderModel3dBitmap(el, model3dGlbResolver);
                    if (bmp) model3dImagesRef.current[el.id] = bmp;
                }
            }
            // 导出跳过位图缺失的 PNG 章/3D 层（占位框只是编辑观感，不烙进成品）；doc 保留引用供再编辑
            const exportDoc: AnnotationDoc = {
                ...doc,
                elements: elements.filter((el) => {
                    if (el.kind === "stamp") return el.builtin || (el.stampId && stampImagesRef.current[el.stampId]);
                    if (el.kind === "model3d") return !!model3dImagesRef.current[el.id];
                    return true;
                }),
            };
            const blob = await exportComposite(bitmap, exportDoc, {
                stampImages: stampImagesRef.current,
                model3dImages: model3dImagesRef.current,
            });
            await finishAnnotation(session, doc, blob);
            dirtyRef.current = false;
            close();
        } catch (err) {
            alert(`涂鸦保存失败：${err instanceof Error ? err.message : "未知错误"}`);
        } finally {
            setSaving(false);
        }
    };

    if (!session) return null;

    const toolBtns: { t: Tool; icon: React.ComponentType<{ className?: string }>; label: string; title: string }[] = [
        { t: "select", icon: MousePointer2, label: "选择", title: "选择元素：拖动移动、Alt+拖动复制；选中框四角拖动=透视变形、四角外缘（双向箭头指针）拖动=旋转、浮条=翻转/复位；Delete 删除所选" },
        { t: "pen", icon: Pen, label: "笔", title: "自由绘制（停顿自动拟合平滑曲线）" },
        { t: "arrow", icon: MoveUpRight, label: "箭头", title: "拖拽画箭头" },
        { t: "rect", icon: Square, label: "矩形", title: "拖拽画矩形" },
        { t: "ellipse", icon: CircleIcon, label: "圆", title: "拖拽画圆/椭圆" },
        { t: "text", icon: TypeIcon, label: "文字", title: "点击图片输入文字" },
        { t: "eraser", icon: Eraser, label: "橡皮", title: "擦除笔画（不是擦画布）：红色半透明预览，靠近线条自动吸附沿线擦；松手生效，露出当前位置原图；移动笔画时擦除跟着走" },
        { t: "dasher", icon: SquareDashed, label: "虚线橡皮", title: "沿路径虚线擦除：红色预览+吸附线条，挖孔沿笔刷走向间隔分段，被擦笔画呈虚线——如桌后人物下半身；随笔画移动。滚轮调虚线密度（上滚更密、下滚更疏）" },
    ];
    const btnCls = (active: boolean) =>
        `flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs transition-colors cursor-pointer whitespace-nowrap ${
            active ? "bg-violet-500/30 text-white" : "text-white/65 hover:text-white hover:bg-white/10"}`;

    // 指针处的预览章（半透明；未选章/位图未就绪则无）
    const previewStamp = tool === "stamp" && stampPtr ? stampElementAt(stampPtr) : null;

    return (
        <div style={{ position: "fixed", inset: 0, zIndex: 100300, background: "rgba(6,8,14,0.92)", display: "flex", flexDirection: "column" }}>
            {/* ── 顶部工具栏 ── */}
            <div onMouseDown={(e) => e.stopPropagation()}
                style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", background: "rgba(14,17,27,0.96)", borderBottom: "1px solid rgba(255,255,255,0.09)", flexWrap: "wrap", position: "relative" }}>
                <span style={{ fontSize: 13, color: "rgba(255,255,255,0.85)", fontWeight: 600, marginRight: 6, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    涂鸦 · {session.source.name || session.source.assetId || "图片"}
                </span>
                {toolBtns.slice(0, 5).map((b) => (
                    <button key={b.t} className={btnCls(tool === b.t)} title={b.title}
                        onClick={() => { setTool(b.t); setStampPanel(false); setAssetPanel(false); if (b.t !== "select") setSelectedId(null); }}>
                        <b.icon className="h-3.5 w-3.5" /><span>{b.label}</span>
                    </button>
                ))}
                {/* 纹章：按钮=启用工具，右侧箭头=开合章库下拉 */}
                <button className={btnCls(tool === "stamp")}
                    title={`纹章：选章后指针即预览，滚轮缩放，点击盖章${activeStamp ? `（当前：${activeStamp.name}）` : "（未选章，点击选择）"}`}
                    onClick={() => {
                        setAssetPanel(false);
                        if (!activeStamp) { setStampPanel((v) => !v); return; }
                        setTool("stamp"); setSelectedId(null); setStampPanel(false);
                    }}>
                    <StampIcon className="h-3.5 w-3.5" /><span>纹章{activeStamp ? `·${activeStamp.name}` : ""}</span>
                    <ChevronDown className="h-3 w-3 opacity-70" onClick={(e) => { e.stopPropagation(); setAssetPanel(false); setStampPanel((v) => !v); }} />
                </button>
                {toolBtns.slice(5).map((b) => (
                    <button key={b.t} className={btnCls(tool === b.t)} title={b.title}
                        onClick={() => { setTool(b.t); setStampPanel(false); setAssetPanel(false); if (b.t !== "select") setSelectedId(null); }}>
                        <b.icon className="h-3.5 w-3.5" /><span>{b.label}</span>
                    </button>
                ))}
                {/* 3D模型：打开导演台在画面里摆模型，模型层嵌回画面（选中后浮条「编辑3D」可再改） */}
                <button className={btnCls(false)}
                    title="3D模型：打开3D导演台，在画面里摆放 可动人偶/道具/GLB 模型；完成后模型层嵌回画面（可移动/变形/擦除，选中后点「编辑3D」再改）"
                    onClick={() => { setStampPanel(false); setAssetPanel(false); open3dStage(); }}>
                    <Bone className="h-3.5 w-3.5" /><span>3D模型</span>
                </button>
                {/* 资产名称下拉：点名字=画面中心落文字并切「选择」；也可把名字拖到画布指定位置（不收起面板） */}
                <div style={{ position: "relative" }}>
                    <button className={btnCls(assetPanel)}
                        title="资产名称：快速把项目资产（主体）的名字作为文字放到画面。点击名字=放到画面中间并切「选择」工具；也可以把名字直接拖到画面指定位置放下"
                        onClick={() => { setStampPanel(false); setAssetPanel((v) => !v); }}>
                        <Tags className="h-3.5 w-3.5" /><span>资产名称</span>
                        <ChevronDown className="h-3 w-3 opacity-70" />
                    </button>
                    {assetPanel && (
                        <div style={{ position: "absolute", top: "100%", left: 0, zIndex: 100320, marginTop: 6, padding: 10, width: 320, maxHeight: "60vh", overflowY: "auto", borderRadius: 10, border: "1px solid rgba(255,255,255,0.14)", background: "#141926", boxShadow: "0 10px 32px rgba(0,0,0,0.6)" }}>
                            <div style={{ fontSize: 11.5, color: "rgba(255,255,255,0.55)", marginBottom: 8 }}>
                                点名字 → 放到画面中间（自动切「选择」可直接拖动）；或<b>把名字拖到画面</b>指定位置放下
                            </div>
                            {assetGroups.length === 0 && (
                                <div style={{ fontSize: 12, color: "rgba(255,255,255,0.45)", padding: "6px 2px" }}>
                                    当前项目还没有已命名的资产（先在资产页拆分/创建资产）
                                </div>
                            )}
                            {assetGroups.map((g) => (
                                <div key={g.label} style={{ marginBottom: 8 }}>
                                    <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", marginBottom: 4 }}>{g.label}</div>
                                    <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                                        {g.names.map((name, i) => (
                                            <button key={`${name}-${i}`} draggable title={`点击放到画面中间；拖到画面=放到指定位置（颜色/粗细跟当前设置）`}
                                                onClick={() => { placeAssetName(name); setAssetPanel(false); }}
                                                onDragStart={(e) => {
                                                    e.dataTransfer.setData(ASSET_NAME_MIME, name);
                                                    e.dataTransfer.setData("text/plain", name);
                                                    e.dataTransfer.effectAllowed = "copy";
                                                }}
                                                style={{ padding: "4px 10px", borderRadius: 999, fontSize: 12, cursor: "grab", border: "1px solid rgba(255,255,255,0.14)", background: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.88)", whiteSpace: "nowrap", maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis" }}>
                                                {name}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
                <div style={{ width: 1, height: 18, background: "rgba(255,255,255,0.12)" }} />
                {/* 填充开关（矩形/圆/矢量章生效） */}
                <button className={btnCls(fillOn)} title="图形填充开关（矩形/圆/矢量章）：实心 / 描边" onClick={() => setFillOn((v) => !v)}>
                    <PaintBucket className="h-3.5 w-3.5" /><span>{fillOn ? "有填充" : "无填充"}</span>
                </button>
                {/* 粗细三档 */}
                {["细", "中", "粗"].map((label, i) => (
                    <button key={label} className={btnCls(sizeIdx === i)} title={`线宽/字号：${label}`} onClick={() => setSizeIdx(i)}>{label}</button>
                ))}
                <div style={{ width: 1, height: 18, background: "rgba(255,255,255,0.12)" }} />
                {/* 颜色 */}
                {SWATCHES.map((c) => (
                    <button key={c} title={c} onClick={() => setColor(c)}
                        style={{ width: 20, height: 20, borderRadius: 999, background: c, cursor: "pointer", border: color === c ? "2px solid #a78bfa" : "2px solid rgba(255,255,255,0.25)", flexShrink: 0 }} />
                ))}
                <input type="color" value={/^#[0-9a-fA-F]{6}$/.test(color) ? color : "#ff3b30"} title="自定义颜色"
                    onChange={(e) => setColor(e.target.value)}
                    style={{ width: 26, height: 22, padding: 0, border: "none", background: "transparent", cursor: "pointer" }} />
                <div style={{ flex: 1 }} />
                <button className={btnCls(false)} title="撤销（Ctrl+Z）" onClick={undo}><Undo2 className="h-3.5 w-3.5" /><span>撤销</span></button>
                <button className={btnCls(false)} title="清空全部涂鸦"
                    onClick={() => { if (elements.length && window.confirm("清空全部涂鸦？")) { snapshot(); setElements([]); setSelectedId(null); } }}>
                    <Trash2 className="h-3.5 w-3.5" /><span>清空</span>
                </button>
                <div style={{ width: 1, height: 18, background: "rgba(255,255,255,0.12)" }} />
                <button className={btnCls(false)} title="放弃并关闭（Esc）" onClick={requestClose}><X className="h-3.5 w-3.5" /><span>取消</span></button>
                <button disabled={saving} title={session.targetNodeId ? "导出合成图并更新本节点（旧图进堆叠历史）" : "导出合成图并在画布新建图片节点"}
                    onClick={() => void onFinish()}
                    className="flex items-center gap-1 rounded-md px-3 py-1.5 text-xs bg-violet-500 hover:bg-violet-400 text-white transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-wait">
                    {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                    <span>{saving ? "保存中…" : "完成"}</span>
                </button>

                {/* ── 章库下拉面板 ── */}
                {stampPanel && (
                    <div style={{ position: "absolute", top: "100%", left: 320, zIndex: 100320, marginTop: 4, padding: 10, width: 316, borderRadius: 10, border: "1px solid rgba(255,255,255,0.14)", background: "#141926", boxShadow: "0 10px 32px rgba(0,0,0,0.6)" }}>
                        <div style={{ fontSize: 11.5, color: "rgba(255,255,255,0.55)", marginBottom: 8 }}>
                            选一枚章 → 图片上移动鼠标预览，<b>滚轮缩放</b>，点击盖章；矢量章跟随颜色/填充/粗细
                        </div>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0,1fr))", gap: 6 }}>
                            {Object.entries(BUILTIN_STAMPS).map(([bid, meta]) => {
                                const Icon = BUILTIN_ICONS[bid] || StampIcon;
                                const on = activeStamp?.builtin === bid;
                                return (
                                    <button key={bid} title={meta.label}
                                        onClick={() => { setActiveStamp({ builtin: bid, name: meta.label }); setTool("stamp"); setStampPanel(false); setSelectedId(null); }}
                                        style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, padding: "8px 4px", borderRadius: 8, cursor: "pointer", border: on ? "1px solid #a78bfa" : "1px solid rgba(255,255,255,0.1)", background: on ? "rgba(139,92,246,0.2)" : "rgba(255,255,255,0.04)", color: "rgba(255,255,255,0.85)" }}>
                                        <Icon className="h-6 w-6" />
                                        <span style={{ fontSize: 11 }}>{meta.label}</span>
                                    </button>
                                );
                            })}
                            {customStamps.map((s) => {
                                const on = activeStamp?.stampId === s.id;
                                return (
                                    <div key={s.id} style={{ position: "relative" }}>
                                        <button title={s.name}
                                            onClick={() => { ensureStampImage(s.id, s.dataUrl); setActiveStamp({ stampId: s.id, name: s.name }); setTool("stamp"); setStampPanel(false); setSelectedId(null); }}
                                            style={{ width: "100%", display: "flex", flexDirection: "column", alignItems: "center", gap: 4, padding: "6px 4px", borderRadius: 8, cursor: "pointer", border: on ? "1px solid #a78bfa" : "1px solid rgba(255,255,255,0.1)", background: on ? "rgba(139,92,246,0.2)" : "rgba(255,255,255,0.04)" }}>
                                            <img src={s.dataUrl} alt={s.name} style={{ width: 30, height: 30, objectFit: "contain" }} />
                                            <span style={{ fontSize: 11, color: "rgba(255,255,255,0.85)", maxWidth: 60, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</span>
                                        </button>
                                        <button title="从章库删除" onClick={() => { removeCustomStamp(s.id); setCustomStamps(listCustomStamps()); if (activeStamp?.stampId === s.id) setActiveStamp(null); }}
                                            style={{ position: "absolute", top: -6, right: -6, width: 16, height: 16, borderRadius: 999, border: "none", background: "rgba(239,68,68,0.9)", color: "#fff", fontSize: 10, lineHeight: "16px", cursor: "pointer" }}>×</button>
                                    </div>
                                );
                            })}
                            {/* ＋ 自定义 PNG */}
                            <button title="添加 PNG 自定义章（存本机章库）" onClick={() => stampFileRef.current?.click()}
                                style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, padding: "8px 4px", borderRadius: 8, cursor: "pointer", border: "1px dashed rgba(255,255,255,0.25)", background: "transparent", color: "rgba(255,255,255,0.6)" }}>
                                <ImagePlus className="h-6 w-6" />
                                <span style={{ fontSize: 11 }}>＋PNG</span>
                            </button>
                        </div>
                        <input ref={stampFileRef} type="file" accept="image/png,image/webp,image/jpeg" style={{ display: "none" }}
                            onChange={(e) => { onPickStampFile(e.target.files?.[0] ?? null); e.target.value = ""; }} />
                    </div>
                )}
            </div>

            {/* ── 画布区 ── */}
            <div style={{ flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
                {loadErr ? (
                    <div style={{ color: "#fca5a5", fontSize: 13 }}>图像加载失败：{loadErr}</div>
                ) : !bitmap || !dims ? (
                    <div style={{ color: "rgba(255,255,255,0.6)", fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
                        <Loader2 className="h-4 w-4 animate-spin" /> 载入图像…
                    </div>
                ) : (
                    <div ref={stageWrapRef} onMouseDown={beginDraw} onMouseMove={onWrapMouseMove} onMouseLeave={() => setStampPtr(null)}
                        onDragOver={(e) => {
                            // 只接资产名称拖拽（自定义 MIME），不拦外部文件拖入
                            if (e.dataTransfer.types.includes(ASSET_NAME_MIME)) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = "copy"; }
                        }}
                        onDrop={(e) => {
                            const name = e.dataTransfer.getData(ASSET_NAME_MIME);
                            if (!name) return;
                            e.preventDefault();
                            e.stopPropagation();
                            const rect = e.currentTarget.getBoundingClientRect();
                            placeAssetName(name, {
                                x: Math.max(0, Math.min(dims.w, (e.clientX - rect.left) / scale)),
                                y: Math.max(0, Math.min(dims.h, (e.clientY - rect.top) / scale)),
                            }); // 拖放不收起面板（可连续拖多个名字）
                        }}
                        style={{ width: dims.w * scale, height: dims.h * scale, cursor: tool === "select" ? (rotHover ? ROTATE_CURSOR : "default") : tool === "text" ? "text" : tool === "eraser" || tool === "dasher" ? "cell" : tool === "stamp" && previewStamp ? "none" : "crosshair", boxShadow: "0 8px 40px rgba(0,0,0,0.6)", borderRadius: 4, overflow: "hidden" }}>
                        <Stage width={dims.w * scale} height={dims.h * scale} scaleX={scale} scaleY={scale}
                            onMouseDown={(e: Konva_.KonvaEventObject<MouseEvent>) => {
                                if (tool === "select" && e.target === e.target.getStage()) setSelectedId(null);
                            }}>
                            <Layer listening={false}>
                                <KImage image={bitmap} width={dims.w} height={dims.h} />
                            </Layer>
                            <Layer>
                                {elements.map((el) => {
                                    const draftQuad = xformDraft?.id === el.id ? xformDraft.quad : null;
                                    const onDbl = () => {
                                        if (el.kind === "text") setTextEdit({ x: el.x, y: el.y, value: el.text, id: el.id });
                                    };
                                    if (el.xform || draftQuad) {
                                        // 带变形（旋转/翻转/透视）：源画布 + 单应网格贴图（蒙版随组一起变形）
                                        return (
                                            <WarpNode key={el.id} el={el} quad={draftQuad ?? el.xform!.quad}
                                                renderCtx={renderCtx} scale={scale}
                                                selected={selectedId === el.id}
                                                interactive={tool === "select" && !saving}
                                                onSelect={() => setSelectedId(el.id)}
                                                onDblClick={onDbl}
                                                onDragEnd={(dx, dy, alt) => moveOrCopy(el, dx, dy, alt)} />
                                        );
                                    }
                                    if (el.masks?.length) {
                                        // 带擦除蒙版：隔离组 cache 后挖孔（透出当前位置原图；拖动时擦除跟随）
                                        return (
                                            <MaskedNode key={el.id} el={el} renderCtx={renderCtx} scale={scale}
                                                selected={selectedId === el.id}
                                                interactive={tool === "select" && !saving}
                                                onSelect={() => setSelectedId(el.id)}
                                                onDblClick={onDbl}
                                                onDragEnd={(dx, dy, alt) => moveOrCopy(el, dx, dy, alt)} />
                                        );
                                    }
                                    const spec = konvaSpecFor(el, renderCtx);
                                    const C = CMP[spec.cls];
                                    const selected = selectedId === el.id;
                                    return (
                                        <C key={el.id} {...spec.config}
                                            draggable={tool === "select" && !saving}
                                            hitStrokeWidth={Math.max(14 / scale, ("width" in el ? el.width : 8) * 2)}
                                            listening={tool === "select"}
                                            {...(selected ? { shadowColor: "#22d3ee", shadowBlur: 14 / scale, shadowOpacity: 1 } : {})}
                                            onMouseDown={(e: Konva_.KonvaEventObject<MouseEvent>) => {
                                                e.cancelBubble = true;
                                                setSelectedId(el.id);
                                            }}
                                            onDblClick={onDbl}
                                            onDragStart={(e: Konva_.KonvaEventObject<DragEvent>) => { altDragRef.current = e.evt.altKey; }}
                                            onDragEnd={(e: Konva_.KonvaEventObject<DragEvent>) => {
                                                // Konva 拖动改的是节点自身 offset：读位移→归零→写回模型（坐标真理在模型）
                                                const dx = e.target.x() - (spec.config.x as number | undefined ?? 0);
                                                const dy = e.target.y() - (spec.config.y as number | undefined ?? 0);
                                                e.target.position({ x: (spec.config.x as number | undefined) ?? 0, y: (spec.config.y as number | undefined) ?? 0 });
                                                if (dx === 0 && dy === 0) return;
                                                moveOrCopy(el, dx, dy, altDragRef.current);
                                            }} />
                                    );
                                })}
                                {draft && (() => {
                                    const spec = konvaSpecFor(draft, renderCtx);
                                    const C = CMP[spec.cls];
                                    return <C {...spec.config} listening={false} />;
                                })()}
                                {/* 在绘橡皮：半透明红色笔刷带预览（吸附修正后的真实路径；虚线橡皮带分段观感；
                                    尾部圆点覆盖单击「点擦」场景），松手结算为元素蒙版 */}
                                {eraseDraft && (
                                    <>
                                        <Line points={eraseDraft.points} stroke="rgba(255,59,48,0.4)" strokeWidth={eraseDraft.width}
                                            lineCap={eraseDraft.dashedLine ? "butt" : "round"} lineJoin="round" listening={false}
                                            {...(eraseDraft.dashedLine ? { dash: maskDashFor(eraseDraft.width, dashScale) } : {})} />
                                        <KCircle x={eraseDraft.points[eraseDraft.points.length - 2]} y={eraseDraft.points[eraseDraft.points.length - 1]}
                                            radius={eraseDraft.width / 2} fill="rgba(255,59,48,0.4)" listening={false} />
                                    </>
                                )}
                                {/* 纹章指针预览（半透明，点击即盖） */}
                                {previewStamp && (() => {
                                    const spec = konvaSpecFor(previewStamp, renderCtx);
                                    const C = CMP[spec.cls];
                                    return <C {...spec.config} listening={false} opacity={0.55} />;
                                })()}
                                {/* 选中框：四角虚线 + 四角透视手柄 + 四角外缘旋转区（翻转/复位在 HTML 浮条——
                                    旋转不再用顶部手柄，会被浮条挡住；改 Figma 式角外环区+双向箭头光标） */}
                                {tool === "select" && !saving && (() => {
                                    const selEl = elements.find((x) => x.id === selectedId);
                                    if (!selEl) return null;
                                    const quad = xformDraft?.id === selEl.id ? xformDraft.quad : quadOfElement(selEl);
                                    const hr = 7 / scale;
                                    return (
                                        <>
                                            <Line points={quad} closed stroke="#22d3ee" strokeWidth={1.5 / scale}
                                                dash={[6 / scale, 4 / scale]} listening={false} />
                                            {/* 旋转区（先画=垫底，角点透视手柄压在上面优先命中）：不可见大圆，悬停变双向箭头光标 */}
                                            {[0, 1, 2, 3].map((i) => (
                                                <KCircle key={`rz${i}`} x={quad[i * 2]} y={quad[i * 2 + 1]} radius={26 / scale}
                                                    fill="#000" opacity={0}
                                                    onMouseEnter={() => setRotHover(true)}
                                                    onMouseLeave={() => setRotHover(false)}
                                                    onMouseDown={(e: Konva_.KonvaEventObject<MouseEvent>) => startQuadHandle(selEl, "rotate", e)} />
                                            ))}
                                            {[0, 1, 2, 3].map((i) => (
                                                <KCircle key={i} x={quad[i * 2]} y={quad[i * 2 + 1]} radius={hr}
                                                    fill="#0e1420" stroke="#22d3ee" strokeWidth={1.5 / scale}
                                                    onMouseEnter={() => setRotHover(false)}
                                                    onMouseDown={(e: Konva_.KonvaEventObject<MouseEvent>) => startQuadHandle(selEl, i, e)} />
                                            ))}
                                        </>
                                    );
                                })()}
                            </Layer>
                        </Stage>
                    </div>
                )}
            </div>

            {/* ── 选中元素的浮动操作条：翻转/复位（点击即生效；拖动手柄期间隐藏） ── */}
            {tool === "select" && !saving && !textEdit && !xformDraft && dims && stageWrapRef.current && (() => {
                const selEl = elements.find((x) => x.id === selectedId);
                if (!selEl) return null;
                const bb = quadBBox(quadOfElement(selEl));
                const rect = stageWrapRef.current.getBoundingClientRect();
                const left = Math.max(8, Math.min(window.innerWidth - 210, rect.left + ((bb.x1 + bb.x2) / 2) * scale - 100));
                const top = Math.max(60, rect.top + bb.y1 * scale - 46);
                const barBtn = "rounded-md px-2 py-1 text-[11px] text-white/80 hover:text-white bg-white/10 hover:bg-white/20 cursor-pointer whitespace-nowrap";
                return (
                    <div style={{ position: "fixed", zIndex: 100310, left, top, display: "flex", gap: 4, padding: 4, borderRadius: 8, background: "rgba(14,17,27,0.95)", border: "1px solid rgba(255,255,255,0.14)", boxShadow: "0 6px 20px rgba(0,0,0,0.5)" }}
                        onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); }}>
                        <button className={barBtn} title="水平翻转（左右镜像）"
                            onClick={() => applyQuad(selEl.id, flipQuad(quadOfElement(selEl), "x"))}>↔ 翻转</button>
                        <button className={barBtn} title="垂直翻转（上下镜像）"
                            onClick={() => applyQuad(selEl.id, flipQuad(quadOfElement(selEl), "y"))}>↕ 翻转</button>
                        {selEl.xform && (
                            <button className={barBtn} title="还原全部变形（旋转/翻转/透视回到原状）"
                                onClick={() => applyQuad(selEl.id, baseQuadOf(selEl))}>复位</button>
                        )}
                        {selEl.kind === "model3d" && (
                            <button className={barBtn} title="重开 3D 导演台继续编辑这个模型层（模型/姿势/相机都可改）"
                                onClick={() => open3dStage(selEl)}>编辑3D</button>
                        )}
                    </div>
                );
            })()}

            {/* ── 文字输入浮层（定位到点击处；mousedown 均 preventDefault 防夺焦） ── */}
            {textEdit && dims && stageWrapRef.current && (() => {
                const rect = stageWrapRef.current.getBoundingClientRect();
                return (
                    <div style={{ position: "fixed", zIndex: 100310, left: Math.min(rect.left + textEdit.x * scale, window.innerWidth - 220), top: Math.min(rect.top + textEdit.y * scale, window.innerHeight - 110) }}
                        onMouseDown={(e) => e.stopPropagation()}>
                        <textarea ref={textAreaRef} autoFocus value={textEdit.value}
                            onChange={(e) => setTextEdit({ ...textEdit, value: e.target.value })}
                            onKeyDown={(e) => {
                                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commitText(); }
                            }}
                            placeholder="输入文字，Enter 确定"
                            style={{
                                display: "block", minWidth: 200, minHeight: 44, padding: "6px 8px",
                                fontSize: Math.max(13, Math.min(28, fontSize * scale)), fontWeight: 700, lineHeight: 1.25,
                                color, background: "rgba(10,12,18,0.88)",
                                border: "1px dashed rgba(167,139,250,0.9)", borderRadius: "6px 6px 0 6px", outline: "none", resize: "both",
                            }} />
                        <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, marginTop: 4 }}>
                            <button onMouseDown={(e) => e.preventDefault()} onClick={() => setTextEdit(null)}
                                className="rounded-md px-2 py-1 text-[11px] text-white/70 hover:text-white bg-white/10 hover:bg-white/20 cursor-pointer">取消</button>
                            <button onMouseDown={(e) => e.preventDefault()} onClick={commitText}
                                className="rounded-md px-2 py-1 text-[11px] text-white bg-violet-500 hover:bg-violet-400 cursor-pointer">确定</button>
                        </div>
                    </div>
                );
            })()}
        </div>
    );
}
