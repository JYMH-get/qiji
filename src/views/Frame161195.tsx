import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import EditorHeader from "@/components/EditorHeader";
import EditorSidebar from "@/components/EditorSidebar";
import { useProjectStore } from "@/store/projectStore";
import { confirmDialog } from "@/lib/confirmDialog";
import { useSettingsStore } from "@/store/settingsStore";
import { startShotGeneration, startDerivedGeneration, recallPendingGeneration, subscribeJobProgress, jobProgressVersion, getJobProgress } from "@/services/generationQueue";
import { progressLabel } from "@/lib/queueLabel";
import VideoProcessModal, { PROCESS_PURPOSE, type VideoProcessSpec, type VideoProcessMode } from "@/components/VideoProcessModal";
import ClipPickerModal from "@/components/ClipPickerModal";
import MediaCompareModal from "@/components/MediaCompareModal";
import { managedClient } from "@/services/managedClient";
import { saveRemoteAsset } from "@/services/assetPersist";
import ModelPicker, { effectiveModelKey, useEffectiveModelKey, useCapModelOptions, useFamilyOrder } from "@/components/ModelPicker";
import TemplatePicker from "@/components/TemplatePicker";
import { useCatalogStore } from "@/store/catalogStore";
import { useModeFeatures } from "@/store/connectionStore";
import { useScrollSnapshot } from "@/hooks/useScrollSnapshot";
import type { Capability } from "@/contract";
import type { ShotMaterial, StoryboardShot, MediaSettings, VideoDerivedRecord } from "@/services/projectFile";
import { BADGE_BG, TAG_BADGE, materialTags, mediaFromMime, mediaOf, buildLegend, withLegend } from "@/lib/shotMaterials";
import { buildAssetListVars } from "@/lib/assetVars";
import { reindexShots } from "@/lib/shotReindex";
import { aspectFromName } from "@/lib/templateAspect";
import { clampDuration, clampImageResolution, resolveSize, IMAGE_ASPECTS, IMAGE_QUALITIES } from "@/lib/genParams";
import { METHOD_LABELS, ASPECT_LABELS, clampMethod, clampToOptions, clampDurationTo } from "@/lib/videoMethods";
// ⚠ 按模型 key 取档位一律走 modelOptions（catalog 查不到时回退本地渠道适配器 mode.paramsSchema）——
// 直接 `models.find(m => m.id === key)` 会让 ComfyUI/LibTV/即梦这类本地模型掉回内置三档（第251轮修的就是这个）
import { videoReqOptionsForKey, imageResolutionOptionsForKey, modelMethodsForKey } from "@/lib/modelOptions";
import { PromptExpandButton } from "@/components/PromptExpandButton";
import { listPresetSchemes, resolvePresets, countUnifiedShots, gridPresetForShotCount, presetBody, hasGridInstruction } from "@/lib/presetSchemes";
import { ShotMaterialStrip } from "@/components/ShotMaterialStrip";
import { importAssetToShot, addShotMaterialFromAsset, removeShotMaterial, reorderShotMaterial, resyncShotLegend, identityIndexesForMaterials, isIdentityShotMaterial, setShotMaterialIdentity, materialKindFromAssetCat } from "@/lib/shotMaterialOps";
import { IdentityAssetToggle } from "@/components/IdentityAssetToggle";
import { AssetImportDropdown } from "@/components/AssetImportDropdown";
import { findProjectAssetByImage, type ProjectAssetCandidate } from "@/lib/projectAssets";
import { validateShotMaterials, type MatVerdict } from "@/lib/materialValidation";
import { uploadMediaToCanvasAsset } from "@/canvas/nodeUpload";
import { ensurePublicUrl as ensurePublicUrlShared } from "@/lib/publicUrl";
import { syncCanvasFromProject } from "@/services/canvasProjection";
import type { MediaKind } from "@/lib/shotMaterials";
import PromptMentionEditor from "@/components/PromptMentionEditor";
import type { PromptMentionHandle } from "@/components/PromptMentionEditor";
import HighlightEditable from "@/components/HighlightEditable";
import { openLightbox } from "@/store/lightboxStore";
import { useAssetFormStore } from "@/store/assetFormStore";
import { captureFromUri, probeVideoDuration } from "@/canvas/videoCapture";
import { makeTermMatcher, stripLegendForMatch } from "@/lib/assetMatch";
import { saveUriToLocal } from "@/lib/saveMedia";
// 本地 CLI 模型（LibTV/即梦，非 catalog）在标题栏显示实名（清单与模型下拉注入同源）
import { LOCAL_MODEL_LABELS, sourceValueOf, modelForSource, modelFamilies, familyOf, modelForFamily, channelOf } from "@/services/adapters/localChannels";
import "@/styles/Frame161195.css";

function isTauri(): boolean {
    return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

// 智能推理的运行/锁定/找回已搬到持久化运行器 @/services/inferRun（startInfer/resumeInferTasks）；解析在 @/lib/smartInferPrompts。
// extractPromptText / buildLegend / withLegend / LEGEND_START 已抽到 @/lib/shotMaterials（视图与 generationQueue 共用）。

const KIND_LABEL: Record<string, string> = {
    character: "角色", scene: "场景", creature: "生物", prop: "道具", local: "本地",
};

// 从资产名解析「匹配候选」（含别名）：按 / ／ 、 | ， 分隔，括号（…）内也作别名。
// 例「陈瞎子/陈满楼」→ ["陈瞎子/陈满楼","陈瞎子","陈满楼"]；「陈瞎子（陈满楼）」→ ["…","陈瞎子","陈满楼"]。
function aliasTerms(name: string): string[] {
    const base = String(name || "").trim();
    if (!base) return [];
    const set = new Set<string>([base]);
    const parens = base.match(/[（(]([^（）()]+)[)）]/g) || [];
    const core = base.replace(/[（(][^（）()]*[)）]/g, "/"); // 去括号留分隔
    for (const part of core.split(/[/／、|，,]/)) { const t = part.trim(); if (t) set.add(t); }
    for (const p of parens) {
        const inner = p.replace(/[（()）]/g, "").trim();
        for (const part of inner.split(/[/／、|，,]/)) { const t = part.trim(); if (t) set.add(t); }
    }
    return [...set].filter(Boolean);
}
// 素材模态/编号/图例工具已抽到 @/lib/shotMaterials（视图与提示词编辑器、generationQueue 共用）。

// 列序：操作 / 原文分段 / 素材 / 提示词 / 故事板 / 视频。
// 列宽与行高来自全局 settingsStore.videoTableLayout（可拖动调整、跨分集/项目记忆）。
const COL_LABELS = ["操作", "原文分段", "素材区", "提示词区", "故事板区", "视频区"];
const MIN_COL = 80;   // 列最小宽（px）
const MIN_ROW = 120;  // 行最小高（px）

type PromptTab = "storyboard" | "video";

// 图像「比例 × 分辨率」→ 出图 size：走 @/lib/genParams 的 resolveSize（全客户端唯一一份 SIZE_MAP，
// 第251轮去重——本文件原有的 IMG_SIZE 副本已删，勿再抄表；resolveSize 对档位大小写不敏感）。
// 画质档只是显示名映射（值集恒取 IMAGE_QUALITIES）
const QUALITY_LABELS: Record<string, string> = { low: "低", medium: "中", high: "高", auto: "自动" };

// 视频片段选择弹窗已抽为共享组件 @/components/ClipPickerModal（画布「分段」共用）。

// 原文只读分格里高亮已匹配资产名（绿色字体，与 HighlightEditable 同色），返回 React 节点数组。
function highlightSegment(text: string, terms: string[]): React.ReactNode {
    if (!text) return null;
    const ts = [...new Set(terms)].filter(Boolean).sort((a, b) => b.length - a.length);
    if (ts.length === 0) return text;
    const flags = new Array(text.length).fill(false);
    for (const t of ts) { let i = text.indexOf(t); while (i >= 0) { for (let k = i; k < i + t.length; k++) flags[k] = true; i = text.indexOf(t, i + t.length); } }
    const out: React.ReactNode[] = [];
    let i = 0, seg = 0;
    while (i < text.length) {
        const on = flags[i];
        let j = i + 1; while (j < text.length && flags[j] === on) j++;
        const piece = text.slice(i, j);
        out.push(on ? <span key={seg++} style={{ color: "#4ade80" }}>{piece}</span> : <span key={seg++}>{piece}</span>);
        i = j;
    }
    return out;
}

const Frame161195 = () => {
    const episodes = useProjectStore((s) => s.episodes);
    const characters = useProjectStore((s) => s.characters);
    const scenes = useProjectStore((s) => s.scenes);
    const items = useProjectStore((s) => s.items);
    const organisms = useProjectStore((s) => s.organisms);
    const crowds = useProjectStore((s) => s.crowds);

    // 界面快照：上次选中的分集 / 各分镜提示词 tab / 表格与分集列表滚动位置（挂载时取一次作初值）
    const snapVideo = useProjectStore.getState().uiSnapshot?.video;
    const [selectedId, setSelectedId] = useState<string | null>(snapVideo?.episodeId ?? null);
    const [vidSettingsOpen, setVidSettingsOpen] = useState(false);
    // 分集重命名（行内编辑）
    const [renameEpId, setRenameEpId] = useState<string | null>(null);
    const [renameEpVal, setRenameEpVal] = useState("");
    // 模式开关（服务端按用户下发）：画布模式被关时隐藏「同步本集到画布」
    const { canvasMode: canvasModeEnabled } = useModeFeatures();
    // 「同步本集到画布」反馈态（仅视频界面：选中分集 → 手动投影资产 + 本集到画布，不自动同步）
    const [canvasSynced, setCanvasSynced] = useState(false);

    // 「视频设置」逐项目持久化（重启不回默认）——全部读写 projectStore.mediaSettings
    const ms = useProjectStore((s) => s.mediaSettings);
    const setMS = (patch: Partial<MediaSettings>) => useProjectStore.getState().setMediaSettings(patch);
    const maxDuration = ms.maxDuration ?? 15;
    const shotCount = ms.shotCount ?? 0;            // 0 = 自动
    const resolution = ms.resolution ?? "720p";
    const aspect = ms.aspect ?? "16:9";
    const genWithAsset = ms.genWithAsset ?? true;
    const genWithStory = ms.genWithStory ?? false;
    const imageAspect = ms.imageAspect ?? "16:9";
    // 分辨率档由服务端按当前生效图像模型下发（catalog params.resolution 枚举，管理端可改），
    // 已存选择不在开放集时归一到第一档（本文件历史用大写档名 "2K"，resolveSize/clampImageResolution 均大小写不敏感）
    const sbImgModelKey = useEffectiveModelKey("image");
    // ⚠ sbModels 订阅保留：modelOptions 内部读 getState()（非响应式），靠本订阅在 catalog 热更时重渲染取到新档位
    const sbModels = useCatalogStore((s) => s.catalog?.models);
    const sbResOptions = imageResolutionOptionsForKey(sbImgModelKey);
    const imageResolution = clampImageResolution(ms.imageResolution, sbResOptions).toUpperCase();
    // 视频「方法/要求」按当前生效视频模型下发（第131轮：catalog methods/params 服务端控档；本地渠道走适配器档位）
    const vidModelKey = useEffectiveModelKey("video");
    const vidMethods = modelMethodsForKey(vidModelKey);
    const vidMethod = clampMethod(ms.videoMethod, vidMethods);
    const vidReq = videoReqOptionsForKey(vidModelKey);
    const imageQuality = ms.imageQuality ?? "high";
    const inferTplId = ms.inferTplId ?? ""; // 智能推理提示词模板（多卡；空=多分镜默认）
    const singleTplId = ms.singleTplId ?? ""; // 单卡推理提示词模板（空=单卡默认）——单镜按键/一键单卡用
    // 图视同源：开启后故事板/视频共用一段「同源提示词」，提示词区单栏、图片与视频共用该栏；推理走同源模板
    const sameSource = ms.imgVideoSameSource ?? false;
    const unifiedTplId = ms.unifiedTplId ?? "";       // 同源·多卡 模板（空=同源多卡默认）
    const unifiedSingleTplId = ms.unifiedSingleTplId ?? ""; // 同源·单卡 模板（空=同源单卡默认）——单镜/一键单卡用
    const imageSize = resolveSize(imageAspect, imageResolution);
    // 第243轮：选中名称带比例标记的推理模板（如「同源推理9:16」）→ 图像/视频比例自动跟随模板比例
    // （用户定稿「优先提示词内比例」；写入即生效、下拉如实显示，之后仍可在下方单独改回=最高优先）
    const catTemplates = useCatalogStore((s) => s.catalog?.templates);
    const pickInferTpl = (patch: Partial<MediaSettings>, tplId: string) => {
        const a = aspectFromName(catTemplates?.find((t) => t.id === tplId)?.name);
        setMS(a ? { ...patch, imageAspect: a, aspect: a } : patch);
    };
    // 当前已选（显式）推理模板的内嵌比例——有则在设置面板给出提示
    const inferAspectTag = aspectFromName(catTemplates?.find((t) => t.id === (sameSource ? unifiedTplId : inferTplId))?.name);
    // 切换模型（或 catalog 热更改档）后，把**已显式选过**的「要求」收敛到新模型档位并落库：
    // 显示层与提交层本就各自 clamp，但存的仍是旧值（换回时会带回越档值、与所见不一致）——这里一次性自愈。
    // 只动显式设过的键（未设的走缺省，不凭空落值）；收敛结果恒在档内 → 不会反复触发。
    useEffect(() => {
        if (!sbModels?.length) return; // catalog 未就绪不动（档位此时是内置回退，会误改）
        const patch: Partial<MediaSettings> = {};
        if (ms.resolution) { const v = clampToOptions(ms.resolution, vidReq.resolutions); if (v !== ms.resolution) patch.resolution = v; }
        if (ms.aspect) { const v = clampToOptions(ms.aspect, vidReq.aspects); if (v !== ms.aspect) patch.aspect = v; }
        if (ms.maxDuration != null) { const v = clampDurationTo(clampDuration(ms.maxDuration), vidReq.durations); if (v !== ms.maxDuration) patch.maxDuration = v; }
        if (ms.videoMethod && vidMethod !== ms.videoMethod) patch.videoMethod = vidMethod;
        if (ms.imageResolution) {
            const v = clampImageResolution(ms.imageResolution, sbResOptions).toUpperCase();
            if (v !== String(ms.imageResolution).toUpperCase()) patch.imageResolution = v;
        }
        if (Object.keys(patch).length) setMS(patch);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [vidModelKey, sbImgModelKey, sbModels]);

    // 视频设置面板单行样式：标题左 + 控件右（不再两行）
    const rowSt: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, fontSize: 11, color: "rgba(255,255,255,0.6)" };
    const rowLb: React.CSSProperties = { whiteSpace: "nowrap", flexShrink: 0 };
    const rowCtl: React.CSSProperties = { flex: 1, minWidth: 0, maxWidth: 170, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 6, color: "#fff", padding: "5px 8px", fontSize: 12, outline: "none", cursor: "pointer" };
    const rowPicker: React.CSSProperties = { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 };

    // ── 表格列宽 / 行高（全局持久化，跨分集/项目；拖动即固定，内容不再自动撑开）──
    const tableLayout = useSettingsStore((s) => s.videoTableLayout);
    const colWidths = tableLayout.colWidths;
    const rowHeight = tableLayout.rowHeight;
    const gridCols = colWidths.map((w) => `${w}px`).join(" ");
    const tableMinW = colWidths.reduce((a, b) => a + b, 0);

    // 拖动列宽（拖表头右边界）：拖动中仅改内存(persist=false)避免逐像素写盘，松手落盘一次。
    const startColResize = (index: number, e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX;
        const startW = useSettingsStore.getState().videoTableLayout.colWidths[index] ?? MIN_COL;
        const onMove = (ev: MouseEvent) => {
            const next = [...useSettingsStore.getState().videoTableLayout.colWidths];
            next[index] = Math.max(MIN_COL, Math.round(startW + (ev.clientX - startX)));
            useSettingsStore.getState().setVideoTableLayout({ colWidths: next }, false);
        };
        const onUp = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
            useSettingsStore.getState().save();
        };
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
    };

    // 拖动行高（拖行下边界，所有行统一一个高度）。
    const startRowResize = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const startY = e.clientY;
        const startH = useSettingsStore.getState().videoTableLayout.rowHeight ?? MIN_ROW;
        const onMove = (ev: MouseEvent) => {
            const next = Math.max(MIN_ROW, Math.round(startH + (ev.clientY - startY)));
            useSettingsStore.getState().setVideoTableLayout({ rowHeight: next }, false);
        };
        const onUp = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
            useSettingsStore.getState().save();
        };
        document.body.style.cursor = "row-resize";
        document.body.style.userSelect = "none";
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
    };

    // 标题栏当前模型信息（仅显示）
    const catalogModels = useCatalogStore((s) => s.catalog?.models);
    useProjectStore((s) => s.projectModelConfig); // 订阅：模型切换后标题栏即时刷新
    const modelLabel = (cap: Capability) => {
        const id = effectiveModelKey(cap);
        return catalogModels?.find((m) => m.id === id)?.label || LOCAL_MODEL_LABELS[id] || id || "未选";
    };
    // 顶部信息栏文案（#7）：画质中文 + 垫图形式
    const QUALITY_LABEL: Record<string, string> = { low: "低画质", medium: "中画质", high: "高画质", auto: "自动画质" };
    const matFormLabel = genWithAsset && genWithStory ? "资产+故事板" : genWithAsset ? "资产" : genWithStory ? "故事板" : "无";
    // 故事板/视频在途任务持久化在 projectStore.pendingGens（切页/重启不丢，凭 taskId 找回）。
    // 历史区占位符与失败均由它驱动（按 shot.shotId + field 过滤）。
    const pendingGens = useProjectStore((s) => s.pendingGens);
    const [addingShotId, setAddingShotId] = useState<string | null>(null);
    const [addAnchor, setAddAnchor] = useState<{ x: number; y: number } | null>(null); // 素材弹层锚点（固定定位，避开行 overflow 裁剪）
    // @引用素材下拉：点「@素材」按钮或在提示词里输入 @ 打开，列出本分镜素材，选中即在光标处插入缩略图胶囊。
    // viaAt=true 表示由输入 @ 触发（插入时需吃掉那个 @）；false 为按钮触发。
    const [mentionShot, setMentionShot] = useState<{ shotId: string; x: number; y: number; viaAt?: boolean } | null>(null);
    const [importShot, setImportShot] = useState<{ shotId: string; x: number; y: number } | null>(null); // 输入 # 导入资产的待选框
    const [presetShot, setPresetShot] = useState<{ shotId: string; x: number; y: number } | null>(null); // 「预设方案」选择器下拉
    // 出图预设方案（服务端「预设方案」模板 + 本地自定义，随 catalog/设置刷新）——供分镜提示词插入胶囊/渲染 pill
    const presetCatalogVer = useCatalogStore((s) => s.catalog?.version);
    const customPresets = useSettingsStore((s) => s.customPresets);
    const presetSchemes = useMemo(() => listPresetSchemes(), [presetCatalogVer, customPresets]);
    const promptRefs = useRef<Record<string, PromptMentionHandle | null>>({}); // 各分镜提示词编辑器句柄（按 shotId 定位光标插入）
    const [promptTab, setPromptTab] = useState<Record<string, PromptTab>>(snapVideo?.promptTab ?? {});
    const [uploading, setUploading] = useState<Record<string, boolean>>({}); // 素材上传中（缩略图转圈）
    const [matError, setMatError] = useState<Record<string, boolean>>({}); // 素材上传失败（红色错误缩略图）
    const [matValid, setMatValid] = useState<Record<string, MatVerdict>>({}); // 视频素材本地初步判断（违规红色❗标记）
    const [segEdit, setSegEdit] = useState<Record<string, boolean>>({}); // 原文分段：某分镜是否进入编辑模式（默认只读分格）
    const [segMenu, setSegMenu] = useState<{ shotId: string; x: number; y: number } | null>(null); // 原文分段右击菜单
    const [genVideoMenu, setGenVideoMenu] = useState(false);   // 「一键生成视频」全部/奇数 下拉
    const [tplName, setTplName] = useState("");                 // 新建表格布局模板名
    const videoTableTemplates = useSettingsStore((s) => s.videoTableTemplates); // 已保存的表格布局模板
    const dragMat = useRef<{ shotId: string; matId: string } | null>(null);    // 素材拖拽重排来源
    // 故事板图 / 视频 右击菜单（导出 / 首尾帧到相邻镜 / 视频片段到下一镜）
    const [mediaMenu, setMediaMenu] = useState<{ x: number; y: number; idx: number; kind: "image" | "video"; uri: string } | null>(null);
    const [clipModal, setClipModal] = useState<{ idx: number; uri: string } | null>(null); // 视频片段选择弹窗
    const [procModal, setProcModal] = useState<{ idx: number; uri: string; mode: VideoProcessMode } | null>(null); // 超分/去字幕/图像超分弹窗
    // 派生记录右击菜单（视频 v1+/v1- 与故事板超分记录共用）：对比原素材 / 设为主图主视频 / 删除
    const [derivedMenu, setDerivedMenu] = useState<{ x: number; y: number; shotId: string; recId: string; field: "video" | "storyboard" } | null>(null);
    // 全屏对比弹窗（对比原图/原视频）
    const [compareData, setCompareData] = useState<{ media: "image" | "video"; beforeUri: string; afterUri: string; afterLabel: string; title: string } | null>(null);
    const [mediaBusy, setMediaBusy] = useState("");                            // 帧提取/裁剪/上传中的全局遮罩文案
    // 单分镜「视频模型」覆盖下拉：与 ModelPicker 同一数据源（启用子集过滤 + LibTV 注入），
    // 修「设置里停用的模型仍出现在提示词区、LibTV 只在视频设置可选」的下拉源分裂
    const videoModels = useCapModelOptions("video");
    // 单卡模型选择「家族 → 渠道/线路 → 模型」三级折叠（第163轮，家族=一级筛选；LibTV/即梦归 Seedance 家族）
    const videoFamOrder = useFamilyOrder();
    const videoFamilies = useMemo(() => modelFamilies(videoModels, videoFamOrder), [videoModels, videoFamOrder]);
    // 当前表格布局若与某个已保存模板完全一致，外部下拉就显示该模板名；拖动改过则回到占位（无匹配）。
    const activeTableTplId = useMemo(() => {
        const cur = tableLayout;
        const m = videoTableTemplates.find((t) =>
            t.layout.rowHeight === cur.rowHeight &&
            t.layout.colWidths.length === cur.colWidths.length &&
            t.layout.colWidths.every((w, i) => w === cur.colWidths[i])
        );
        return m?.id ?? "";
    }, [tableLayout, videoTableTemplates]);

    useEffect(() => {
        // 快照里的分集若已不存在（被删 / 换项目），回退到第一集
        if (episodes.length > 0 && !episodes.some((e) => e.id === selectedId)) setSelectedId(episodes[0].id);
    }, [episodes, selectedId]);

    const activeEp = episodes.find((e) => e.id === selectedId) || null;

    // 选中分集变更 → 写入快照（跳过首帧初值回写）
    const firstEpRef = useRef(true);
    useEffect(() => {
        if (firstEpRef.current) { firstEpRef.current = false; return; }
        useProjectStore.getState().setUiSnapshot({ video: { episodeId: selectedId ?? undefined } });
    }, [selectedId]);

    // 视频素材本地初步判断：素材变化 → 异步校验（数量/分辨率/大小/时长），违规标红❗。按 matId+uri+media 签名触发。
    const matSig = useMemo(
        () => (activeEp?.shots || []).map((s) => `${s.id}:${s.materials.map((m) => `${m.id}|${m.uri}|${m.media || "image"}`).join(",")}`).join(";"),
        [activeEp],
    );
    useEffect(() => {
        if (!activeEp) { setMatValid({}); return; }
        let cancelled = false;
        (async () => {
            const all: Record<string, MatVerdict> = {};
            for (const shot of activeEp.shots) {
                if (!shot.materials.length) continue;
                Object.assign(all, await validateShotMaterials(shot.materials));
            }
            if (!cancelled) setMatValid(all);
        })();
        return () => { cancelled = true; };
    }, [matSig]); // eslint-disable-line react-hooks/exhaustive-deps

    // 各分镜提示词 tab 变更 → 写入快照
    const firstTabRef = useRef(true);
    useEffect(() => {
        if (firstTabRef.current) { firstTabRef.current = false; return; }
        useProjectStore.getState().setUiSnapshot({ video: { promptTab } });
    }, [promptTab]);

    // 滚动位置快照：分镜表格主体 + 左侧分集列表
    const tableScroll = useScrollSnapshot(
        snapVideo?.tableScrollTop,
        (top) => useProjectStore.getState().setUiSnapshot({ video: { tableScrollTop: top } }),
        [activeEp?.id, activeEp?.shots?.length],
    );
    const epListScroll = useScrollSnapshot(
        snapVideo?.episodeListScrollTop,
        (top) => useProjectStore.getState().setUiSnapshot({ video: { episodeListScrollTop: top } }),
        [episodes.length],
    );

    // 资产池（用于匹配素材）：角色/群像/场景/生物/物品；每项带 terms（名称+别名+各造型名）供匹配与高亮。
    // forms=该资产全部有图造型（基础形象+变体）——提取资产时优先用「原文点名的造型 > 资产助手当前选中造型 > 基础形象」。
    type PoolForm = { variantId: string | null; name: string; uri: string; terms: string[] };
    type PoolItem = { kind: ShotMaterial["kind"]; name: string; uri: string; assetId: string; terms: string[]; forms: PoolForm[]; voiceUri?: string; voiceAssetId?: string; voiceName?: string };
    const assetPool = useMemo(() => {
        const pool: PoolItem[] = [];
        const push = (kind: ShotMaterial["kind"], a: any) => {
            const baseTerms = aliasTerms(a.name);
            const baseSet = new Set(baseTerms);
            const forms: PoolForm[] = [];
            if (a.image) forms.push({ variantId: null, name: a.name, uri: a.image, terms: [] });
            for (const v of a.variants ?? []) {
                if (!v.image) continue;
                // 造型自身的匹配词（剔除与基础名重复的，避免恒命中造型盖过助手选中造型）
                const terms = aliasTerms(v.name || "").filter((t) => !baseSet.has(t));
                forms.push({ variantId: v.id, name: v.name || `${a.name}·${v.label || "造型"}`, uri: v.image, terms });
            }
            pool.push({
                kind, name: a.name, uri: a.image || "", assetId: a.id,
                terms: [...new Set([...baseTerms, ...forms.flatMap((f) => f.terms)])],
                forms, voiceUri: a.voiceUri, voiceAssetId: a.voiceAssetId, voiceName: a.voiceName,
            });
        };
        for (const c of characters) push("character", c);
        for (const g of crowds) push("character", g);      // 群像（G 编号）一并匹配
        for (const s of scenes) push("scene", s);
        for (const o of organisms) push("creature", o);
        for (const i of items) push("prop", i);
        return pool.filter((p) => p.name);
    }, [characters, crowds, scenes, items, organisms]);

    // 原文高亮词：**所有提取到的资产**（角色/群像/场景/生物/物品）名称+别名+造型名，任意出现在原文即高亮（绿色字体）。
    // 含单字资产名（如「山」「庙」）——只要在原文出现就高亮。
    const assetHighlightTerms = useMemo(() => {
        const set = new Set<string>();
        for (const a of assetPool) for (const t of a.terms) if (t.length >= 1) set.add(t);
        return [...set];
    }, [assetPool]);

    // 按资产 id 反查资产名（资产助手原生拖拽只带文件名=资产id.ext，丢了资产名；据此还原真实资产名）
    const assetNameById = (assetId: string): string => {
        const get = useProjectStore.getState();
        for (const arr of [characters, crowds, scenes, organisms, items] as any[][]) {
            for (const a of arr) {
                if (a.image && get.blobByUri(a.image)?.id === assetId) return a.name;
                for (const v of (a.variants || [])) if (v.image && get.blobByUri(v.image)?.id === assetId) return v.name || a.name;
            }
        }
        return "";
    };

    // ── 智能推理「推理中」状态（持久化 inferTasks 派生）：跨切页/重启不丢锁、禁二次点击 ──
    const inferTasks = useProjectStore((s) => s.inferTasks);
    const epInferring = (epId?: string): boolean => !!epId && inferTasks.some((t) => t.episodeId === epId && t.mode === "multi" && t.status === "running");
    const epInferError = (epId?: string): string | undefined => inferTasks.find((t) => !!epId && t.episodeId === epId && t.mode === "multi" && t.status === "failed")?.error;
    const shotInferring = (shotId: string): boolean => inferTasks.some((t) => t.shotId === shotId && t.mode === "single" && t.status === "running");
    // 智能拆分（整集）「拆分中」状态
    const epSplitting = (epId?: string): boolean => !!epId && inferTasks.some((t) => t.episodeId === epId && t.mode === "split" && t.status === "running");
    const epSplitError = (epId?: string): string | undefined => inferTasks.find((t) => !!epId && t.episodeId === epId && t.mode === "split" && t.status === "failed")?.error;
    // 本集正在推理中的单镜头数（一键推理所有单镜头的防呆与进度）
    const epShotInferringCount = (epId?: string): number => inferTasks.filter((t) => !!epId && t.episodeId === epId && t.mode === "single" && t.status === "running").length;
    // 整集级互斥锁：智能推理 / 智能拆分 任一在跑 → 两者及一键推理都锁住（防并发覆盖同一集）
    const epLocked = (epId?: string): boolean => epInferring(epId) || epSplitting(epId);
    // 整集级当前忙碌文案：拆分中 / 推理中（两按钮同步显示同一状态，视觉上一起锁住）
    // 服务端排队（如奇迹云 FIFO）时带上位次——「排队第3」比恒久不动的「推理中…」有信息量
    const epBusyLabel = (epId?: string): string | null => {
        const t = inferTasks.find((x) => !!epId && x.episodeId === epId && x.mode === "split" && x.status === "running")
            ?? inferTasks.find((x) => !!epId && x.episodeId === epId && x.mode === "multi" && x.status === "running");
        if (!t) return null;
        const base = t.mode === "split" ? "拆分中" : "推理中";
        const q = getJobProgress(t.id)?.extra?.queuePosition;
        return q ? `${base}·排队第${q}` : `${base}…`;
    };
    // 禁用态视觉样式（置灰 + 禁用光标），避免「看着还能点」
    const lockedStyle = (epId?: string): React.CSSProperties => epLocked(epId) ? { opacity: 0.5, cursor: "not-allowed" } : {};

    // ── 在途任务（持久化 pendingGens）按 key 派生：key=`sb-${shotId}` / `vid-${shotId}` ──
    // 进度/排队位次是会话态（generationQueue 的 Map，不落盘）：订阅版本号触发重渲染，值走 getJobProgress
    useSyncExternalStore(subscribeJobProgress, jobProgressVersion, jobProgressVersion);
    const fieldOf = (key: string): "storyboard" | "video" => (key.startsWith("sb-") ? "storyboard" : "video");
    const shotIdOf = (key: string): string => key.replace(/^sb-|^vid-/, "");
    const jobList = (key: string) => pendingGens.filter((p) => p.shot?.shotId === shotIdOf(key) && p.shot.field === fieldOf(key));
    const isRunning = (key: string) => jobList(key).some((p) => p.status === "running");
    const lastError = (key: string): string | undefined =>
        [...jobList(key)].reverse().find((p) => p.status === "failed")?.error;
    // 历史区占位符（运行中=转圈「生成中」；失败=红色「失败 ✕」点击移除该 pending）
    const jobChips = (key: string) =>
        jobList(key).map((p) => {
            const jp = getJobProgress(p.id);
            return p.status === "running" ? (
                <span key={p.id} title="生成中（切页/重启会自动找回，完成后加入历史，不阻塞继续生成）"
                    style={{ display: "inline-flex", alignItems: "center", gap: 4, flexShrink: 0, fontSize: 10, padding: "2px 8px", borderRadius: 4, border: "1px solid rgba(139,92,246,0.5)", background: "rgba(139,92,246,0.15)", color: "#c4b5fd", alignSelf: "center" }}>
                    <span className="sb-spin" style={{ display: "inline-block" }}>↻</span>{progressLabel(jp?.progress ?? null, jp?.extra)}
                </span>
            ) : p.recoverable ? (
                // 服务端异常（lost）：凭原 taskId 重连找回，不重新生成、不再扣费
                <button key={p.id} title={`${p.error || "服务端异常"}（点击重连原任务找回结果）`} onClick={() => recallPendingGeneration(p.id)}
                    style={{ display: "inline-flex", alignItems: "center", gap: 4, flexShrink: 0, fontSize: 10, padding: "2px 8px", borderRadius: 4, cursor: "pointer", border: "1px solid rgba(251,191,36,0.6)", background: "rgba(251,191,36,0.14)", color: "#fbbf24", alignSelf: "center" }}>
                    ↻ 重连原任务
                </button>
            ) : (
                <button key={p.id} title={`${p.error || "生成失败"}（点击移除）`} onClick={() => useProjectStore.getState().removePendingGen(p.id)}
                    style={{ flexShrink: 0, fontSize: 10, padding: "2px 8px", borderRadius: 4, cursor: "pointer", border: "1px solid rgba(248,113,113,0.5)", background: "rgba(248,113,113,0.12)", color: "#f87171", alignSelf: "center" }}>
                    失败 ✕
                </button>
            );
        });
    const tabOf = (id: string): PromptTab => promptTab[id] || "storyboard";

    const update = (shotId: string, patch: Partial<StoryboardShot>) => {
        if (!activeEp) return;
        useProjectStore.getState().updateShot(activeEp.id, shotId, patch);
    };

    // 在提示词光标处插入素材引用胶囊（底层=@ImageN 模型规范 tag，界面渲染成缩略图胶囊）。
    // 编辑器内部把改动 serialize 回 plain text 并经 onChange 落库；故此处只调句柄、不直接改 store。
    const insertMention = (shot: StoryboardShot, mat: ShotMaterial) => {
        const tag = materialTags(shot.materials)[mat.id];
        const viaAt = mentionShot?.viaAt ?? false;
        setMentionShot(null);
        promptRefs.current[shot.id]?.insertMaterial(tag, viaAt);
    };
    // 输入 # 导入项目资产：加入本镜素材区 + 在光标处插入 @ 胶囊（# 被吃掉）。
    const importMention = (shot: StoryboardShot, cand: ProjectAssetCandidate) => {
        setImportShot(null);
        if (!activeEp) return;
        const r = importAssetToShot(activeEp.id, shot.id, cand);
        if (r) promptRefs.current[shot.id]?.insertMaterial(r.tag, true, r.mat);
    };
    // 重排编号：算法收编到 lib/shotReindex（与 inferRun / 实时剪辑工作台「补镜头」共用一份，勿分叉）
    const reindex = reindexShots;
    // 切换某分镜的「补镜头」标记并重排编号
    const toggleSupplement = (shot: StoryboardShot) => {
        if (!activeEp) return;
        commitShots(activeEp.shots.map((s) => (s.id === shot.id ? { ...s, isSupplement: !s.isSupplement } : s)));
    };
    // 更新某分镜的局部覆盖（#12 单分镜设置）
    const setShotOverride = (shot: StoryboardShot, patch: Partial<NonNullable<StoryboardShot["overrides"]>>) => {
        update(shot.id, { overrides: { ...(shot.overrides || {}), ...patch } });
    };
    // 单镜换模型：把本镜已选「要求/方法」一并收敛到新模型档位（新模型不支持的旧档位绝不留着——
    // 显示层虽有 clamp，但存着越档值会在换回时带回来，且与用户所见不一致）
    const setShotVideoModel = (shot: StoryboardShot, videoModelKey: string) => {
        const req = videoReqOptionsForKey(videoModelKey);
        const ov = shot.overrides || {};
        const patch: Partial<NonNullable<StoryboardShot["overrides"]>> = { videoModelKey };
        if (ov.resolution) patch.resolution = clampToOptions(ov.resolution, req.resolutions);
        if (ov.aspect) patch.aspect = clampToOptions(ov.aspect, req.aspects);
        if (ov.duration) patch.duration = clampDurationTo(clampDuration(ov.duration), req.durations);
        if (ov.method) patch.method = clampMethod(ov.method, modelMethodsForKey(videoModelKey));
        const nextDur = shot.durationSec != null ? clampDurationTo(clampDuration(shot.durationSec), req.durations) : undefined;
        update(shot.id, {
            overrides: { ...ov, ...patch },
            ...(nextDur != null && nextDur !== shot.durationSec ? { durationSec: nextDur } : {}),
        });
    };
    // 素材重排（#15 拖拽排序）：把 fromId 移动到 toId 之前/之后
    // 素材重排走 shotMaterialOps（图例整体重建 + 正文 @ 引用重映射）——裸写 materials 会让 @ 编号与图例错位，勿回退
    const reorderMaterials = (shot: StoryboardShot, fromId: string, toId: string) => {
        if (activeEp) reorderShotMaterial(activeEp.id, shot.id, fromId, toId);
    };
    const commitShots = (shots: StoryboardShot[]) => {
        if (!activeEp) return;
        useProjectStore.getState().setEpisodeShots(activeEp.id, reindex(shots));
        void useProjectStore.getState().save(true);
    };
    // 流式合并 / 收尾已搬到持久化运行器 @/services/inferRun（startInfer/resumeInferTasks），
    // 使「推理中」状态与结果落地不依赖本组件存活（切页/重启不丢锁、可找回）。

    /**
     * 把任意素材 uri 解析成「公网可达 url」供上游 fetch。**唯一实现在 @/lib/publicUrl**（与画布模式共用，不做两套）。
     * 本地素材上传期间用 matId 显示缩略图转圈。
     */
    const ensurePublicUrl = (uri: string, name?: string, matId?: string): Promise<string> =>
        ensurePublicUrlShared(uri, {
            name,
            onUploading: matId
                ? (busy) => setUploading((p) => { const n = { ...p }; if (busy) n[matId] = true; else delete n[matId]; return n; })
                : undefined,
        });

    // ── 分集 ──
    const handleAddEpisode = () => {
        const id = useProjectStore.getState().addEpisode();
        setSelectedId(id);
    };
    // 分集重命名：行内编辑（Enter/失焦提交，Esc 取消）
    const startRenameEp = (ep: { id: string; title: string }) => { setRenameEpId(ep.id); setRenameEpVal(ep.title); };
    const commitRenameEp = () => {
        if (renameEpId && renameEpVal.trim()) useProjectStore.getState().updateEpisode(renameEpId, { title: renameEpVal.trim() });
        setRenameEpId(null);
    };
    // 同步本集到画布：手动单向投影「资产 + 当前选中分集」成画布节点（清除其它集投影节点）。
    // 不自动同步——只有在此点击才投影；会覆盖同名投影节点的提示词/结果，画布手建/裂变节点不受影响。
    const syncEpisodeToCanvas = () => {
        if (!activeEp) { alert("请先在左侧选择分集"); return; }
        // 多画布：先切到本集的独立画布（载入其自己的节点/连线），再把「资产 + 本集分镜」投影进去
        useProjectStore.getState().switchCanvas(activeEp.id);
        try { syncCanvasFromProject(activeEp.id); } catch (err) { console.error("同步到画布失败", err); }
        setCanvasSynced(true);
        setTimeout(() => setCanvasSynced(false), 1800);
    };
    // 分集删除：连同本集分镜/提示词 + 本集画布一并删除（不可撤销）。至少保留一集。
    const deleteEp = async (ep: { id: string; title: string }) => {
        if (episodes.length <= 1) { alert("至少保留一集，无法删除最后一个分集。"); return; }
        if (!(await confirmDialog(`删除分集「${ep.title}」？将一并移除本集全部分镜、提示词与该集画布，操作不可撤销。`))) return;
        useProjectStore.getState().deleteEpisode(ep.id);
        if (renameEpId === ep.id) setRenameEpId(null);
    };

    // 智能拆分（整集）：本集原文 → 仅拆出镜头行（原文分段，不含提示词）。提示词模板留服务端配置
    // （templateId `storyboard.split.smart`，缺失则回退 purpose 默认 / 原文兜底）。持久化运行（可找回）+ 锁定防呆。
    const SMART_SPLIT_TPL = "storyboard.split.smart";
    const handleSplit = async () => {
        if (!activeEp) { alert("请先在左侧选择或新建分集"); return; }
        if (!activeEp.scriptText.trim()) { alert("请先填写本集剧本内容（在「原文拆分」区粘贴本集剧本）"); return; }
        if (epLocked(activeEp.id)) return; // 智能推理/智能拆分任一在跑 → 锁定
        if (activeEp.shots.length > 0 && !(await confirmDialog("当前分集已有分镜，智能拆分将删除并重新拆分。继续？"))) return;
        const epId = activeEp.id;
        const scriptText = activeEp.scriptText;
        useProjectStore.getState().setEpisodeShots(epId, []); // 覆盖：清空整集（拆分中 → 视图自动切到分镜表格，边出边填）
        const { startInfer } = await import("@/services/inferRun");
        startInfer({ episodeId: epId, mode: "split", templateId: SMART_SPLIT_TPL, variables: { 原文: scriptText, 视觉风格: useProjectStore.getState().visualStyle || "", ...buildAssetListVars() }, modelKey: effectiveModelKey("text") || undefined });
    };

    // 一键推理所有单镜头：对本集每个镜头逐个走「智能推理（单镜头）」模式（smart.infer.single），各自独立锁定/可找回。
    // 覆盖：先清空各镜两段提示词。防呆：本集有单镜在推理时禁用（按钮显示进度）。
    const inferAllShots = async () => {
        if (!activeEp) return;
        if (epShotInferringCount(activeEp.id) > 0 || epLocked(activeEp.id)) return; // 已有单镜在推理 / 整集推理拆分中 → 锁定
        const targets = activeEp.shots.filter((s) => (s.scriptSegment || s.prompt || "").trim());
        if (targets.length === 0) { alert("没有可推理的镜头。请先「智能拆分」或填写各镜头原文。"); return; }
        if (!(await confirmDialog(`将对 ${targets.length} 个镜头逐个单卡推理（删除并覆盖各镜头当前提示词）。继续？`))) return;
        const epId = activeEp.id;
        // 覆盖：清空该镜提示词（同源清 unifiedPrompt，否则清故事板/视频两段）
        targets.forEach((s) => update(s.id, sameSource ? { unifiedPrompt: "" } : { storyboardPrompt: "", videoPrompt: "" }));
        const { SMART_INFER_SINGLE_TPL, SMART_INFER_UNIFIED_SINGLE_TPL } = await import("@/lib/smartInferPrompts");
        const { startInfer, buildNeighborVars } = await import("@/services/inferRun");
        const assetVars = buildAssetListVars();
        // 邻镜上下文（{{上上一分镜}}{{上一分镜}}{{下一分镜}}）取当前集最新分镜（结果已清空 → 邻镜多回退原文）
        const freshShots = useProjectStore.getState().episodes.find((e) => e.id === epId)?.shots ?? [];
        // 单卡模板：视频设置所选（逐项目持久化），空=单卡默认；同源模式用同源·单卡模板
        const stpl = sameSource ? (unifiedSingleTplId || SMART_INFER_UNIFIED_SINGLE_TPL) : (singleTplId || SMART_INFER_SINGLE_TPL);
        targets.forEach((s) => startInfer({ episodeId: epId, mode: "single", sameSource, shotId: s.id, templateId: stpl, variables: { 原文: (s.scriptSegment || s.prompt || "").trim(), ...assetVars, ...buildNeighborVars(freshShots, s.id, sameSource) }, modelKey: effectiveModelKey("text") || undefined }));
    };

    // 智能推理（多镜）：本集原文 → 一次产出每卡的 原文 + 故事板提示词 + 视频提示词（流式增量——出一卡显示一卡）。
    // 持久化运行（startInfer）：登记 inferTasks 即上锁，「推理中」状态/结果落地不依赖本组件存活（切页/重启不丢、可找回）。
    const handleSmartInfer = async () => {
        if (!activeEp) { alert("请先在左侧选择或新建分集"); return; }
        if (!activeEp.scriptText.trim()) { alert("请先填写本集剧本内容（在「原文拆分」区粘贴本集剧本）"); return; }
        if (epLocked(activeEp.id)) return; // 智能推理/智能拆分任一在跑 → 锁定，禁止二次点击（防并发冲突）
        if (activeEp.shots.length > 0 && !(await confirmDialog("当前分集已有分镜，智能推理将删除当前提示词并覆盖。继续？"))) return;
        const epId = activeEp.id;
        const scriptText = activeEp.scriptText;
        useProjectStore.getState().setEpisodeShots(epId, []); // 覆盖：清空整集（推理中 → 视图自动切到分镜表格，边出边填）
        const { SMART_INFER_MULTI_TPL, SMART_INFER_UNIFIED_TPL } = await import("@/lib/smartInferPrompts");
        const { startInfer } = await import("@/services/inferRun");
        // 提示词模板：视频设置/底部下拉所选（逐项目持久化），空=多分镜默认；同源模式用同源·多卡模板
        const mtpl = sameSource ? (unifiedTplId || SMART_INFER_UNIFIED_TPL) : (inferTplId || SMART_INFER_MULTI_TPL);
        startInfer({ episodeId: epId, mode: "multi", sameSource, templateId: mtpl, variables: { 原文: scriptText, 视觉风格: useProjectStore.getState().visualStyle || "", ...buildAssetListVars() }, modelKey: effectiveModelKey("text") || undefined });
    };

    // ① 单卡智能推理：对**单个分镜**用 smart.infer.single 模板，一次产出本镜的 故事板提示词 + 视频提示词。
    //    覆盖：先清空该镜两段提示词；original_script 单卡模式原样保留（不覆盖 scriptSegment）。同样走持久化运行（可找回）。
    const inferShot = async (shot: StoryboardShot) => {
        if (!activeEp) return;
        const text = (shot.scriptSegment || shot.prompt || "").trim();
        if (!text) { alert("该分镜没有原文，无法推理。请先在原文区填写本镜内容。"); return; }
        if (shotInferring(shot.id)) return; // 已在推理中 → 锁定
        update(shot.id, sameSource ? { unifiedPrompt: "" } : { storyboardPrompt: "", videoPrompt: "" }); // 覆盖：清空提示词
        const { SMART_INFER_SINGLE_TPL, SMART_INFER_UNIFIED_SINGLE_TPL } = await import("@/lib/smartInferPrompts");
        const { startInfer, buildNeighborVars } = await import("@/services/inferRun");
        // 邻镜上下文（{{上上一分镜}}{{上一分镜}}{{下一分镜}}）取最新分镜（上一镜若已推理即拼其结果，保持连贯）
        const freshShots = useProjectStore.getState().episodes.find((e) => e.id === activeEp.id)?.shots ?? [];
        // 单卡模板：视频设置所选（逐项目持久化），空=单卡默认；同源模式用同源·单卡模板
        const stpl = sameSource ? (unifiedSingleTplId || SMART_INFER_UNIFIED_SINGLE_TPL) : (singleTplId || SMART_INFER_SINGLE_TPL);
        startInfer({ episodeId: activeEp.id, mode: "single", sameSource, shotId: shot.id, templateId: stpl, variables: { 原文: text, ...buildAssetListVars(), ...buildNeighborVars(freshShots, shot.id, sameSource) }, modelKey: effectiveModelKey("text") || undefined });
    };

    // ── 向上/下拆（按换行行在相邻大分镜间迁移）──
    // 空行不是分格：迁移按**非空行**计（与外显分格一一对应——外显首格/末格即被迁移的行），
    // 顺带把本镜残留的空行清掉（老数据自愈）。
    const splitMove = (idx: number, dir: "up" | "down") => {
        if (!activeEp) return;
        const shots = activeEp.shots.map((s) => ({ ...s }));
        const cur = shots[idx];
        const curLines = (cur.scriptSegment || "").split(/\r?\n/).filter((l) => l.trim());
        if (dir === "up") {
            if (idx === 0) { alert("已是第一段，无法上拆"); return; }
            if (curLines.length === 0) return;
            const moved = curLines.shift() ?? "";
            const prev = shots[idx - 1];
            prev.scriptSegment = `${(prev.scriptSegment || "").replace(/\s+$/, "")}\n${moved}`.replace(/^\n+/, "");
            cur.scriptSegment = curLines.join("\n");
        } else {
            if (idx === shots.length - 1) { alert("已是最后一段，无法下拆"); return; }
            if (curLines.length === 0) return;
            const moved = curLines.pop() ?? "";
            const nx = shots[idx + 1];
            nx.scriptSegment = `${moved}\n${(nx.scriptSegment || "").replace(/^\s+/, "")}`.replace(/\n+$/, "");
            cur.scriptSegment = curLines.join("\n");
        }
        commitShots(shots);
    };

    // ── 向上/下增空大分镜 ──
    const addShotAt = (idx: number, where: "above" | "below") => {
        if (!activeEp) return;
        const shots = activeEp.shots.map((s) => ({ ...s }));
        const blank: StoryboardShot = {
            id: `shot-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
            index: 0, title: "", scriptSegment: "", prompt: "", materials: [],
        };
        shots.splice(where === "above" ? idx : idx + 1, 0, blank);
        commitShots(shots);
    };

    // 把当前素材的图例（@ImageN 是 资产名）刷新进提示词前缀（视频含全模态、故事板仅图像）
    const refreshLegend = (shot: StoryboardShot, materials: ShotMaterial[]): Partial<StoryboardShot> => {
        const patch: Partial<StoryboardShot> = {};
        // 图视同源：图例写进唯一的 unifiedPrompt（含音色配对，因该提示词也喂视频）
        if (sameSource) {
            const uLeg = buildLegend(materials, false);
            if (uLeg || shot.unifiedPrompt) patch.unifiedPrompt = withLegend(shot.unifiedPrompt || "", uLeg);
            return patch;
        }
        const vLeg = buildLegend(materials, false);
        const sLeg = buildLegend(materials, true);
        if (vLeg || shot.videoPrompt) patch.videoPrompt = withLegend(shot.videoPrompt || "", vLeg);
        if (sLeg || shot.storyboardPrompt) patch.storyboardPrompt = withLegend(shot.storyboardPrompt || "", sLeg);
        return patch;
    };

    // ── 提取（匹配）资产：扫 原文 + 故事板/视频提示词 → 角色/群像/场景/生物/物品命中（场景不做低阈值保底）──
    // 匹配范围（第86轮扩大）：不只原文——智能推理产出的提示词里同样点名资产（{角色:名} 公式等），一并扫描；
    // 提示词先剥掉「【素材图例】」前缀行（那是上一轮提取写入的资产名清单，参与匹配会自我循环）。
    // 命中标准：归一化精确子串 或 相似度 ≥80%（makeTermMatcher，与画布匹配同一把尺）。
    // draftOv：提示词放大弹窗的「匹配资产」——以弹窗草稿代替该 tab 的已存提示词参与匹配与图例写入
    // （草稿尚未保存，落盘值可能滞后；弹窗保存时再落一次同值幂等）。
    const matchAssets = (shot: StoryboardShot, draftOv?: { tab: PromptTab | "unified"; text: string }): boolean => {
        const sbPrompt = draftOv?.tab === "storyboard" ? draftOv.text : (shot.storyboardPrompt || "");
        const vdPrompt = draftOv?.tab === "video" ? draftOv.text : (shot.videoPrompt || "");
        const uniPrompt = draftOv?.tab === "unified" ? draftOv.text : (shot.unifiedPrompt || "");
        const text = [
            shot.scriptSegment,
            stripLegendForMatch(sbPrompt),
            stripLegendForMatch(vdPrompt),
            stripLegendForMatch(uniPrompt),
            shot.prompt,
        ].filter(Boolean).join("\n");
        const matches = makeTermMatcher(text);
        // 去重：同一张图片（同 assetId 或同 uri）只允许一条；音频同理按 assetId/uri 判重。
        const matched: ShotMaterial[] = [];
        const has = (assetId?: string, uri?: string) => matched.some((m) => (!!assetId && m.assetId === assetId) || (!!uri && m.uri === uri));
        // 先折叠已有素材里的重复（清理历史遗留的重复条目）。浅拷贝——后面可能就地回填 uri，不得变异 store 里的旧对象
        for (const m of shot.materials) { if (!has(m.assetId, m.uri)) matched.push({ ...m }); }
        const selFormMap = useAssetFormStore.getState().selForm;
        const add = (a: PoolItem) => {
            // 用哪个造型的图：原文点名的造型 > 资产助手当前选中造型 > 基础形象 > 第一个有图造型
            const hitForm = a.forms.find((f) => f.variantId !== null && f.terms.some((t) => t && matches(t)));
            const sel = selFormMap[a.assetId];
            const selForm = sel !== undefined ? a.forms.find((f) => f.variantId === sel) : undefined;
            const form = hitForm ?? selForm ?? a.forms.find((f) => f.variantId === null) ?? a.forms[0];
            const uri = form?.uri || a.uri;
            // 素材名：原文点名的造型用造型名（便于上游按名注 @tag）；否则用资产名（原文里出现的是它）
            const name = hitForm ? hitForm.name : a.name;
            const exist = matched.find((m) => (!!a.assetId && m.assetId === a.assetId) || (!!uri && m.uri === uri));
            if (exist) {
                // 此前无图时提取进来的素材（uri 空）：资产出图后再提取 → 回填新图，不再永久空占编号
                if (!exist.uri && uri) exist.uri = uri;
            } else if (uri) {
                // ⚠ 无图资产不推入素材：空 uri 素材会占用图例 @ 编号、提交时又无图可发 → 编号一一对应被破坏（勿回退）
                matched.push({ id: `mat-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, assetId: a.assetId, kind: a.kind, media: "image", name, uri });
            }
            // 角色绑定了音色 → 自动把声音参考（音频）也加入素材区，标记归属角色供图例配对「@角色N的声音参考@音频M」。
            // ⚠ 必须独立于上面的图片判重：此前「图已在素材区就提前 return」把音色代码短路——
            // 先提取过一次再绑音色的角色，音频永远加不进来（=用户报的"部分角色声音匹配不上"）。
            if (a.voiceUri && !has(a.voiceAssetId, a.voiceUri)) {
                matched.push({ id: `mat-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, assetId: a.voiceAssetId, kind: "local", media: "audio", name: a.voiceName || `${a.name}的声音`, uri: a.voiceUri, voiceForAssetId: a.assetId });
            }
        };
        // 全部五类（角色/群像/场景/生物/物品）：名称、别名或造型名命中即匹配
        for (const a of assetPool) {
            if (a.terms.some((t) => t && matches(t))) add(a);
        }
        if (matched.length === 0) return false; // 无素材可用 → 无可提取/无图例
        // 加入新素材（若有）+ 刷新图例前缀（每次提取按当前素材重建，不重复堆叠）；
        // 有草稿覆盖时图例基于草稿文本重建（该 tab 的新提示词=草稿+图例，随 update 落盘）
        const shotForLegend = draftOv ? { ...shot, storyboardPrompt: sbPrompt, videoPrompt: vdPrompt, unifiedPrompt: uniPrompt } : shot;
        update(shot.id, { materials: matched, ...refreshLegend(shotForLegend, matched) });
        return true;
    };
    const handleMatchOne = (shot: StoryboardShot) => {
        if (!matchAssets(shot)) alert("未在该分镜原文中匹配到资产，且素材区为空——无可提取的素材。");
    };
    const handleMatchAll = () => {
        if (!activeEp) return;
        let n = 0;
        for (const s of activeEp.shots) if (matchAssets(s)) n++;
        void useProjectStore.getState().save(true);
        alert(n > 0 ? `已为 ${n} 个分镜提取资产并写入素材图例。` : "未匹配到资产、且无现有素材可生成图例。");
    };

    // ── 生成故事板（图像模型；持久化在途 → 切页/重启可找回；本地直显 + 历史记录）──
    const genStoryboard = async (shot: StoryboardShot) => {
        if (!activeEp) return;
        // 提交前展开预设胶囊【预设:id】→ 完整预设词（与画布同链路，显示层仍是 pill）
        let prompt = resolvePresets((sameSource ? shot.unifiedPrompt : shot.storyboardPrompt) || shot.scriptSegment || "");
        // 图视同源「宫格补丁」（仅故事板图，视频用同源提示词原文）：图/视共用同源提示词对图片不完美——
        // **单卡推理产出同源提示词之后**才按其内镜头数自动补宫格预设（4镜→4宫格…更多→9宫格；数不出默认4宫格）。
        // ⚠ 必须有 unifiedPrompt（推理结果）才补——推理还没出结果（回退到原文）时不补，否则无镜头可数（第117轮补充7）。
        if (sameSource && (shot.unifiedPrompt || "").trim() && !hasGridInstruction(prompt)) {
            const gid = gridPresetForShotCount(countUnifiedShots(prompt));
            const body = gid ? presetBody(gid) : undefined;
            if (body) prompt = `${prompt}\n\n${body}`;
        }
        if (!prompt.trim()) { alert(sameSource ? "该分镜还没有同源提示词，请先「智能推理」生成，或在提示词区手动填写。" : "该分镜还没有故事板提示词，请先「智能推理」生成，或在提示词区手动填写。"); return; }
        // 垫图须公网可达：软件资产是 asset.localhost 本地直链，先上传成公网 url（与视频一致），再落持久任务。
        // 故事板=图像生成，只取图像素材（视频/音频对图像模型无意义），保序以对齐 @ImageN。
        // ⚠ 一张都不许静默丢（与服务端第118轮同尺）：图例按素材区给每条编号，丢一条=其后引用整体错位——
        // 不可用素材一律明确报错、请求不发出（用户补图/删素材后重试）。
        const imgs: { url: string; name?: string }[] = [];
        for (const m of shot.materials) {
            if (mediaOf(m) !== "image") continue;
            if (!m.uri) { alert(`分镜${shot.index}的素材「${m.name}」没有图片（资产未出图或上传失败）。垫图与提示词 @ 编号按位对应，缺一张会整体错位——请补图或删除该素材后重试。`); return; }
            const u = await ensurePublicUrl(m.uri, m.name, m.id);
            if (!u) { alert(`分镜${shot.index}的素材「${m.name}」无法取得公网直链（原文件失效或网络异常），请重新上传该素材或删除后重试。`); return; }
            imgs.push({ url: u, name: m.name });
        }
        startShotGeneration({
            episodeId: activeEp.id, shotId: shot.id, field: "storyboard",
            purpose: "asset.scene.image",
            prompt, // → variables.prompt（视觉风格由 queue 注入）
            params: { size: imageSize, quality: imageQuality },
            input: imgs.length ? { images: imgs } : undefined,
            modelKey: effectiveModelKey("image") || undefined,
            label: `${shot.title || "分镜"}·故事板`,
        });
    };

    // ── 生成视频（带资产/带故事板可选；持久化在途 → 切页/重启可找回；本地直显 + 历史记录）──
    const genVideo = async (shot: StoryboardShot): Promise<boolean> => {
        if (!activeEp) return false;
        const opt = { asset: genWithAsset, story: genWithStory };
        // 提交前展开预设胶囊（同源提示词也可能含预设胶囊——它同时喂图片与视频）
        const prompt = resolvePresets((sameSource ? shot.unifiedPrompt : shot.videoPrompt) || shot.scriptSegment || "");
        if (!prompt.trim()) { alert(sameSource ? "该分镜还没有同源提示词，请先「智能推理」生成，或在提示词区手动填写。" : "该分镜还没有视频提示词，请先「智能推理」生成，或在提示词区手动填写。"); return false; }
        if (opt.story && !shot.storyboardUri) { alert(`分镜${shot.index}勾选了「带故事板」但尚未生成故事板。`); return false; }
        // 第131轮：模型→方法→要求（方法/档位服务端控）；第251轮：档位走 modelOptions——
        // ⚠ 提交层必须与显示层同一把尺，只查 catalog 会把 720p 发给只收 480/640/768/1080 的本地渠道上游
        const ovPre = shot.overrides || {};
        const vModelKey = ovPre.videoModelKey || effectiveModelKey("video") || "";
        const vModel = useCatalogStore.getState().model(vModelKey); // 仅用于 officialAssets（真人图，catalog 专属字段）
        const methods = modelMethodsForKey(vModelKey);
        const method = clampMethod(ovPre.method || ms.videoMethod, methods);
        if (method === "frames") {
            // 首尾帧前置校验（与服务端同尺）：首帧=故事板图（带故事板时）或素材第 1 张图；尾帧=素材下一张图
            const imgCount = opt.asset ? shot.materials.filter((m) => { const md = mediaOf(m); return md !== "video" && md !== "audio"; }).length : 0;
            const frameSrc = (opt.story && shot.storyboardUri ? 1 : 0) + imgCount;
            if (frameSrc < 2) {
                alert(`分镜${shot.index}选择了「首尾帧」方法，需要两张图：首帧（故事板图或素材第 1 张图片）+ 尾帧（素材下一张图片）。请勾选「带故事板/带资产」并补齐图片素材后重试。`);
                return false;
            }
        }
        // 故事板 → 整体首帧参考（image_url，无需 @tag）；本地图先上传成公网 url
        let firstFrameUrl = "";
        if (opt.story && shot.storyboardUri) firstFrameUrl = await ensurePublicUrl(shot.storyboardUri, "故事板");
        // 资产/垫素材 → 按模态分组（公网 url + name），各组保序以对齐 @ImageN/@VideoN/@AudioN；服务端按名注入 @tag。
        // ⚠ 一张都不许静默丢（与服务端第118轮同尺）：图例按素材区给每条编号，丢一条=其后同模态引用整体错位——
        // 不可用素材一律明确报错、请求不发出（用户补图/删素材后重试）。
        const images: { id?: string; url: string; name?: string; usage?: "reference" | "identity" }[] = [];
        const videos: { url: string; name?: string }[] = [];
        const audios: { url: string; name?: string }[] = [];
        if (opt.asset) {
            let imageIndex = 0;
            for (const m of shot.materials) {
                if (!m.uri) { alert(`分镜${shot.index}的素材「${m.name}」没有文件（资产未出图或上传失败）。垫素材与提示词 @ 编号按位对应，缺一条会整体错位——请补图或删除该素材后重试。`); return false; }
                const u = await ensurePublicUrl(m.uri, m.name, m.id);
                if (!u) { alert(`分镜${shot.index}的素材「${m.name}」无法取得公网直链（原文件失效或网络异常），请重新上传该素材或删除后重试。`); return false; }
                const md = mediaOf(m);
                const baseRef = { url: u, name: m.name, ...(m.assetId && !m.assetId.startsWith("LC-") ? { id: m.assetId } : {}) };
                if (md === "video") videos.push(baseRef);
                else if (md === "audio") audios.push(baseRef);
                else {
					const identity = isIdentityShotMaterial(m, imageIndex, ovPre.officialAssetIndexes);
					images.push({ ...baseRef, usage: identity ? "identity" : "reference" });
					imageIndex++;
				}
            }
        }
        const input: Record<string, unknown> = {};
        if (images.length) input.images = images;
        if (videos.length) input.videos = videos;
        if (audios.length) input.audios = audios;
        // 单分镜覆盖优先（未设置回退全局视频设置）；「要求」三档按当前模型 catalog params 收敛（服务端控档一把尺）
        const ov = ovPre;
        const req = videoReqOptionsForKey(vModelKey);
        const officialIdx = vModel?.officialAssets
            ? identityIndexesForMaterials(shot.materials, ov.officialAssetIndexes).filter((i) => i >= 0 && i < images.length)
            : [];
        startShotGeneration({
            episodeId: activeEp.id, shotId: shot.id, field: "video",
            purpose: "video.generate",
            prompt,
            params: {
                duration: clampDurationTo(clampDuration(ov.duration || shot.durationSec || maxDuration), req.durations),
                resolution: clampToOptions(ov.resolution || resolution, req.resolutions),
                aspect_ratio: clampToOptions(ov.aspect || aspect, req.aspects),
                ...(firstFrameUrl ? { firstFrameUrl } : {}),
                ...(methods.length > 1 ? { method } : {}),
                ...(officialIdx.length ? { officialAssetIndexes: officialIdx } : {}),
            },
            input: Object.keys(input).length ? input : undefined,
            modelKey: vModelKey || undefined,
            label: `${shot.title || "分镜"}·视频`,
        });
        return true;
    };

    // ── 一键系列（顺序遍历当前分集分镜）──
    const runAll = async (fn: (s: StoryboardShot) => Promise<unknown>) => {
        if (!activeEp) return;
        for (const s of useProjectStore.getState().episodes.find((e) => e.id === activeEp.id)?.shots || []) {
            await fn(s);
        }
    };
    // #13 一键生成视频：全部 / 奇数位（第1、3、5…镜）
    const handleGenAllVideos = async (mode: "all" | "odd") => {
        setGenVideoMenu(false);
        if (!activeEp) return;
        const shots = useProjectStore.getState().episodes.find((e) => e.id === activeEp.id)?.shots || [];
        const targets = mode === "odd" ? shots.filter((_, i) => i % 2 === 0) : shots;
        if (targets.length === 0) { alert(mode === "odd" ? "没有奇数位分镜可生成。" : "当前分集没有分镜可生成。"); return; }
        if (!(await confirmDialog(`将提交 ${targets.length} 个视频生成任务（${mode === "odd" ? "仅奇数位分镜" : "全部分镜"}），确定？`))) return;
        for (const s of targets) await genVideo(s);
    };

    // ── 导出所有视频（先已落本地，按序复制到目标文件夹）──
    const handleExportAll = async () => {
        if (!activeEp) return;
        const withVideo = activeEp.shots.filter((s) => s.videoUri);
        if (withVideo.length === 0) { alert("当前分集没有已生成的视频可导出。"); return; }
        const safe = (t: string) => (t || "").replace(/[\\/:*?"<>|]/g, "_") || "未命名";
        if (isTauri()) {
            try {
                const { open } = await import("@tauri-apps/plugin-dialog");
                const dir = await open({ directory: true, multiple: false, title: "选择导出文件夹" }) as string | null;
                if (!dir) return;
                const { copyFile } = await import("@tauri-apps/plugin-fs");
                const { join } = await import("@tauri-apps/api/path");
                let n = 0, skipped = 0;
                for (let i = 0; i < activeEp.shots.length; i++) {
                    const s = activeEp.shots[i];
                    if (!s.videoUri) continue;
                    const blob = useProjectStore.getState().blobByUri(s.videoUri);
                    if (!blob?.localPath) { skipped++; continue; }
                    const ext = blob.ext || "mp4";
                    const name = `${String(i + 1).padStart(3, "0")}-${safe(activeEp.title)}-${safe(s.title)}.${ext}`;
                    await copyFile(blob.localPath, await join(dir, name));
                    n++;
                }
                alert(`已导出 ${n} 个视频到所选文件夹${skipped ? `（${skipped} 个无本地文件，已跳过）` : ""}。`);
            } catch (err) {
                alert(`导出失败：${err instanceof Error ? err.message : "未知错误"}`);
            }
        } else {
            // 浏览器降级：依次触发下载
            activeEp.shots.forEach((s, i) => {
                if (!s.videoUri) return;
                const a = document.createElement("a");
                a.href = s.videoUri;
                a.download = `${String(i + 1).padStart(3, "0")}-${safe(activeEp.title)}-${safe(s.title)}.mp4`;
                a.click();
            });
        }
    };

    // ── 素材增删（一律走 shotMaterialOps：图例同步重建/正文 @ 重编号；裸写 materials 会错位，勿回退）──
    const removeMaterial = (shot: StoryboardShot, matId: string) => {
        if (activeEp) removeShotMaterial(activeEp.id, shot.id, matId);
    };
    const addAssetMaterial = (shot: StoryboardShot, a: { kind: ShotMaterial["kind"]; name: string; uri: string; assetId: string }) => {
        setAddingShotId(null);
        if (!activeEp) return;
        // 无图资产不入素材区：空 uri 素材会占用图例 @ 编号、提交时又无图可发 → 编号一一对应被破坏
        if (!a.uri) { alert(`资产「${a.name}」还没有形象图，无法作为垫图素材（请先生成/绑定图片）。`); return; }
        addShotMaterialFromAsset(activeEp.id, shot.id, { assetId: a.assetId, uri: a.uri, name: a.name, media: "image", kind: a.kind });
    };
    // 按 id 更新某素材的 uri/assetId（读最新 store，避免异步后闭包过期）
    const setMaterialUri = (matId: string, uri: string, assetId?: string) => {
        const epId = activeEp?.id; if (!epId) return;
        const ep = useProjectStore.getState().episodes.find((e) => e.id === epId);
        const sh = ep?.shots.find((s) => s.materials.some((m) => m.id === matId));
        if (!sh) return;
        useProjectStore.getState().updateShot(epId, sh.id, {
            materials: sh.materials.map((m) => (m.id === matId ? { ...m, uri, ...(assetId ? { assetId } : {}) } : m)),
        });
    };
    const addLocalMaterial = async (shot: StoryboardShot, file: File) => {
        setAddingShotId(null);
        const matId = `mat-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        const name = file.name.replace(/\.[^.]+$/, "");
        const media = mediaFromMime(file.type || "");
        // 先占位（缩略图转圈）；上传**原始文件**（保分辨率/格式，不压缩）→ 存全分辨率公网 url（图像/视频/音频同走 OSS）。
        // 严格：上传失败不回退本地缩略图，直接标红错误缩略图（避免误以为已上传成功）。
        // 占位素材同样占 @ 编号 → 加入即同步图例（上传完成只回填 uri，编号/名字不变，图例无需再刷）。
        update(shot.id, { materials: [...shot.materials, { id: matId, kind: "local", media, name, uri: "" }] });
        if (activeEp) resyncShotLegend(activeEp.id, shot.id);
        setUploading((p) => ({ ...p, [matId]: true }));
        setMatError((p) => { const n = { ...p }; delete n[matId]; return n; });
        try {
            const up = await uploadMediaToCanvasAsset(file, "TP"); // 原图上传 OSS（含 sha256 去重）+ 本地副本显示
            // 去重：该资产（同 assetId/uri）已作为其它素材存在本镜 → 移除占位（走统一入口，图例/编号同步）、不重复加入
            const cur = useProjectStore.getState().episodes.find((e) => e.id === activeEp?.id)?.shots.find((s) => s.id === shot.id);
            const dup = cur?.materials.some((m) => m.id !== matId && ((up.assetId && m.assetId === up.assetId) || (up.displayUri && m.uri === up.displayUri)));
            if (dup && activeEp) {
                removeShotMaterial(activeEp.id, shot.id, matId);
            } else {
                setMaterialUri(matId, up.displayUri, up.assetId);
            }
        } catch (e) {
            console.warn("[video] 素材上传失败（不降级，标红错误）：", e);
            setMatError((p) => ({ ...p, [matId]: true }));
        } finally {
            setUploading((p) => { const n = { ...p }; delete n[matId]; return n; });
        }
    };
    const onMaterialDrop = (shot: StoryboardShot, e: React.DragEvent) => {
        e.preventDefault();
        // 拖动的是某分镜素材：
        //  · 落到**本分镜**容器空白处 → 忽略（重排只在缩略图之间发生）；
        //  · 落到**其它分镜**的素材区 → 复制该素材到本分镜（跨分镜复制）。
        if (dragMat.current) {
            const { shotId: fromShot, matId } = dragMat.current;
            dragMat.current = null;
            if (fromShot !== shot.id && activeEp) {
                const src = activeEp.shots.find((s) => s.id === fromShot)?.materials.find((m) => m.id === matId);
                // 跨分镜复制走统一入口（内含 assetId/uri 去重 + 图例同步）；kind/media/音色归属随行
                if (src) addShotMaterialFromAsset(activeEp.id, shot.id, { assetId: src.assetId, uri: src.uri, name: src.name, media: mediaOf(src), kind: src.kind, usage: src.usage, voiceForAssetId: src.voiceForAssetId });
            }
            return;
        }
        const raw = e.dataTransfer.getData("application/x-qiji-asset") || e.dataTransfer.getData("text/plain");
        if (raw) {
            try {
                const d = JSON.parse(raw);
                const u = d?.localUri || d?.uri || d?.url; // 展示优先本地 uri（CSP 安全）；公网 url 发上游时由 ensurePublicUrl 取回
                if (u && activeEp) {
                    const md: MediaKind = d?.media === "video" || d?.media === "audio" ? d.media : "image";
                    const aid: string | undefined = d?.assetId || d?.id || undefined;
                    // 统一入口（内含去重 + 图例同步）
                    addShotMaterialFromAsset(activeEp.id, shot.id, { assetId: aid, uri: u, name: d.name || "素材", media: md, kind: materialKindFromAssetCat(d?.cat) });
                    return;
                }
            } catch { /* 落到文件分支 */ }
        }
        const f = e.dataTransfer.files?.[0];
        if (f && /^(image|video|audio)\//.test(f.type)) {
            // 图像可能是软件内（资产助手）拖出的已登记资产：文件名=资产id.ext → 解析回 url + **真实资产名**（非文件名/资产id）
            if (f.type.startsWith("image/")) {
                const base = f.name.replace(/\.[^.]+$/, "");
                const blob = useProjectStore.getState().assetBlobs[base];
                const ref = blob?.localUri || blob?.url; // 展示优先本地 uri（CSP 安全）
                if (ref && activeEp) {
                    const bound = findProjectAssetByImage(ref, base);
                    addShotMaterialFromAsset(activeEp.id, shot.id, { assetId: bound?.assetId || base, uri: ref, name: bound?.name || assetNameById(base) || base, media: "image", kind: bound?.kind });
                    return;
                }
            }
            void addLocalMaterial(shot, f);
        }
    };

    // ── 故事板图 / 视频 右击菜单：导出 / 首尾帧到相邻镜 / 视频片段到下一镜 ──
    // 把任意素材 blob 上传成临时资产（TP）+ 本地副本，作垫图加入目标分镜的素材区。
    const addMaterialToShot = async (targetShotId: string, blob: Blob, name: string, media: MediaKind) => {
        if (!activeEp) return;
        const ext = ((blob.type.split("/")[1] || (media === "video" ? "webm" : "png")).split(";")[0]).replace("jpeg", "jpg");
        const fname = `${name.replace(/[\\/:*?"<>|]/g, "_")}.${ext}`;
        const res = await managedClient.uploadAsset(blob, fname, "TP");
        const saved = await saveRemoteAsset(res.id, res.url);
        useProjectStore.getState().registerAssetBlob(saved || { id: res.id, url: res.url });
        const uri = saved?.localUri || res.url;
        // 统一入口（shotMaterialOps 内部读最新 store + 去重 + 图例同步）
        addShotMaterialFromAsset(activeEp.id, targetShotId, { assetId: res.id, uri, name, media });
    };

    // 加载视频为同源 blob: 对象（避免 asset.localhost/公网跨域污染 canvas/captureStream）；失败回退直链。
    const loadVideoEl = async (uri: string): Promise<{ video: HTMLVideoElement; revoke: () => void }> => {
        let src = uri, obj = "";
        try { const resp = await fetch(uri); if (resp.ok) { obj = URL.createObjectURL(await resp.blob()); src = obj; } } catch { /* 回退直链 */ }
        const video = document.createElement("video");
        video.src = src; video.muted = true; video.preload = "auto"; (video as HTMLVideoElement & { playsInline?: boolean }).playsInline = true;
        await new Promise<void>((res, rej) => { video.onloadedmetadata = () => res(); video.onerror = () => rej(new Error("视频加载失败")); });
        return { video, revoke: () => { if (obj) URL.revokeObjectURL(obj); } };
    };
    const seekTo = (video: HTMLVideoElement, t: number) => new Promise<void>((res, rej) => {
        const done = () => { video.removeEventListener("seeked", done); res(); };
        video.addEventListener("seeked", done);
        video.onerror = () => rej(new Error("定位失败"));
        try { video.currentTime = t; } catch { rej(new Error("定位失败")); }
    });
    // 取视频首帧 / 尾帧 → PNG blob
    const grabFrame = async (uri: string, which: "first" | "last"): Promise<Blob> => {
        const { video, revoke } = await loadVideoEl(uri);
        try {
            await seekTo(video, which === "first" ? 0 : Math.max(0, (video.duration || 0) - 0.05));
            const c = document.createElement("canvas");
            c.width = video.videoWidth || 1280; c.height = video.videoHeight || 720;
            const ctx = c.getContext("2d"); if (!ctx) throw new Error("canvas 不可用");
            ctx.drawImage(video, 0, 0, c.width, c.height);
            return await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("帧导出失败"))), "image/png"));
        } finally { revoke(); }
    };
    // 实时录制 [start,end] 片段 → webm blob（耗时约等于片段时长）
    const grabClip = (uri: string, start: number, end: number, onProgress?: (r: number) => void): Promise<Blob> =>
        new Promise<Blob>((resolve, reject) => {
            void (async () => {
                let revoke = () => { };
                try {
                    const loaded = await loadVideoEl(uri); revoke = loaded.revoke;
                    const video = loaded.video;
                    const dur = video.duration || 0;
                    const s = Math.max(0, Math.min(start, dur));
                    const e = Math.max(s + 0.1, Math.min(end, dur || end));
                    const cap = (video as HTMLVideoElement & { captureStream?: () => MediaStream; mozCaptureStream?: () => MediaStream });
                    const capture = cap.captureStream?.bind(video) || cap.mozCaptureStream?.bind(video);
                    if (!capture || typeof MediaRecorder === "undefined") { revoke(); reject(new Error("当前环境不支持视频裁剪")); return; }
                    await seekTo(video, s);
                    let stream: MediaStream;
                    try { stream = capture(); } catch { revoke(); reject(new Error("无法捕获视频流")); return; }
                    const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9") ? "video/webm;codecs=vp9" : "video/webm";
                    const rec = new MediaRecorder(stream, { mimeType: mime });
                    const chunks: BlobPart[] = [];
                    rec.ondataavailable = (ev) => { if (ev.data.size) chunks.push(ev.data); };
                    rec.onstop = () => { revoke(); resolve(new Blob(chunks, { type: "video/webm" })); };
                    rec.onerror = () => { revoke(); reject(new Error("录制失败")); };
                    rec.start(100);
                    void video.play();
                    const tick = () => {
                        if (video.currentTime >= e || video.ended) { try { video.pause(); } catch { /* ignore */ } if (rec.state !== "inactive") rec.stop(); return; }
                        onProgress?.(Math.min(1, (video.currentTime - s) / (e - s)));
                        requestAnimationFrame(tick);
                    };
                    requestAnimationFrame(tick);
                } catch (err) { revoke(); reject(err instanceof Error ? err : new Error("裁剪失败")); }
            })();
        });

    // 菜单动作：导出（复用全局 saveUriToLocal：Tauri 选保存路径 / 浏览器下载）
    const menuExport = () => {
        if (!mediaMenu) return;
        const { uri, kind, idx } = mediaMenu;
        setMediaMenu(null);
        const sh = activeEp?.shots[idx];
        const baseName = `${activeEp?.title || "分集"}-${sh?.title || `分镜${idx + 1}`}-${kind === "video" ? "视频" : "故事板"}`;
        saveUriToLocal(uri, baseName, kind).catch((err) => alert(`导出失败：${err instanceof Error ? err.message : "未知错误"}`));
    };
    // 菜单动作：把（图片本身 / 视频首尾帧）作图像垫图加入相邻镜
    const menuAddFrame = async (which: "first" | "last", dir: "prev" | "next") => {
        if (!mediaMenu || !activeEp) return;
        const { uri, kind, idx } = mediaMenu;
        setMediaMenu(null);
        const shots = useProjectStore.getState().episodes.find((e) => e.id === activeEp.id)?.shots || [];
        const target = shots[dir === "prev" ? idx - 1 : idx + 1];
        if (!target) { alert(dir === "prev" ? "已是第一个分镜，没有上一镜。" : "已是最后一个分镜，没有下一镜。"); return; }
        try {
            setMediaBusy(kind === "image" ? "处理图片中…" : "提取帧中…");
            let blob: Blob, nm: string;
            if (kind === "image") {
                blob = await (await fetch(uri)).blob();
                nm = `${shots[idx]?.title || "分镜"}·图`;
            } else {
                nm = `${shots[idx]?.title || "分镜"}·${which === "first" ? "首帧" : "尾帧"}`;
                // 优先内置 ffmpeg（本地原件直读，无损 PNG）；非 Tauri/失败回退浏览器 canvas 截帧。
                let timeSec = 0;
                if (which === "last") { const d = await probeVideoDuration(uri); timeSec = Math.max(0, d - 0.1); }
                const cap = await captureFromUri(uri, "frame", { timeSec }).catch(() => null);
                blob = cap?.blob ?? await grabFrame(uri, which);
            }
            setMediaBusy("上传中…");
            await addMaterialToShot(target.id, blob, nm, "image");
            setMediaBusy("");
        } catch (err) { setMediaBusy(""); alert(`操作失败：${err instanceof Error ? err.message : "未知错误"}`); }
    };
    // 菜单动作：打开视频片段选择弹窗
    const menuAddClip = () => {
        if (!mediaMenu) return;
        const { uri, idx } = mediaMenu;
        setMediaMenu(null);
        setClipModal({ idx, uri });
    };
    // 弹窗确认 → 录制裁剪 → 作视频垫图加入下一镜
    const doAddClip = async (start: number, end: number) => {
        if (!clipModal || !activeEp) return;
        const { uri, idx } = clipModal;
        setClipModal(null);
        const shots = useProjectStore.getState().episodes.find((e) => e.id === activeEp.id)?.shots || [];
        const target = shots[idx + 1];
        if (!target) { alert("已是最后一个分镜，没有下一镜。"); return; }
        try {
            setMediaBusy("裁剪视频中…");
            // 优先内置 ffmpeg（真·mp4 重编码裁剪，无需等待播放）；非 Tauri/失败回退浏览器实时录制（webm）。
            const cap = await captureFromUri(uri, "clip", { startSec: start, endSec: end }).catch(() => null);
            const blob = cap?.blob ?? await grabClip(uri, start, end, (r) => setMediaBusy(`裁剪视频中… ${Math.round(r * 100)}%`));
            setMediaBusy("上传中…");
            await addMaterialToShot(target.id, blob, `${shots[idx]?.title || "分镜"}·片段[${start.toFixed(1)}-${end.toFixed(1)}s]`, "video");
            setMediaBusy("");
        } catch (err) { setMediaBusy(""); alert(`视频裁剪失败：${err instanceof Error ? err.message : "未知错误"}`); }
    };
    // 菜单动作：打开 超分/去字幕/图像超分 弹窗
    const menuProcess = (mode: VideoProcessMode) => {
        if (!mediaMenu) return;
        const { uri, idx } = mediaMenu;
        setMediaMenu(null);
        setProcModal({ idx, uri, mode });
    };
    // 弹窗确认 → 追加派生记录（running 态）→ 源视频公网化 → 提交火山 MediaKit（generationQueue 持久化在途，
    // 完成后 applyDerivedResult 把处理产物本地化写回记录）。标号规则：
    // 处理输入 = 右击时选中的那条记录的产物（链式允许：对 v1+ 去字幕处理的是超分后的 720 版）；
    // 标号**不叠加后缀**——恒为 v{n}+ / v{n}-，取决于最后一次处理（n=链条根记录号）；同标号唯一，后到覆盖。
    const doProcessVideo = (spec: VideoProcessSpec) => {
        if (!procModal || !activeEp) return;
        const { idx, uri, mode } = procModal;
        const epId = activeEp.id;
        setProcModal(null);
        const shots = useProjectStore.getState().episodes.find((e) => e.id === epId)?.shots || [];
        const sh = shots[idx];
        if (!sh) return;
        // 派生记录失败标红（记录仍在，可重新处理覆盖）——视频/故事板两个记录表共用
        const markDerivedFail = (shotId: string, field: "videoDerived" | "sbDerived", recId: string, msg: string) => {
            const cur = useProjectStore.getState().episodes.find((e) => e.id === epId)?.shots.find((s) => s.id === shotId);
            const list = cur?.[field];
            if (!list?.some((d) => d.id === recId)) return;
            useProjectStore.getState().updateShot(epId, shotId, {
                [field]: list.map((d) => (d.id === recId ? { ...d, status: "failed" as const, error: msg } : d)),
            });
        };
        // ── 故事板图像超分：sbDerived 记录（同源唯一，后到覆盖），结果与原图并列显示在故事板历史条 ──
        if (mode === "imageUpscale") {
            const derived = sh.sbDerived || [];
            const rec: VideoDerivedRecord = {
                id: `sd-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
                kind: "upscale",
                uri: "", // 处理完成后由 applyDerivedResult 写入产物本地 uri
                srcUri: uri,
                srcLabel: "故事板",
                label: "超分",
                createdAt: Date.now(),
                params: spec.params,
                modelKey: spec.modelKey,
                status: "running",
            };
            update(sh.id, { sbDerived: [...derived.filter((d) => d.srcUri !== uri), rec] });
            void (async () => {
                try {
                    const publicUrl = await ensurePublicUrl(uri, `${sh.title || "分镜"}·故事板`);
                    if (!publicUrl) { markDerivedFail(sh.id, "sbDerived", rec.id, "源图公网化失败（上传 OSS 未成功），请重试"); return; }
                    const blob = useProjectStore.getState().blobByUri(uri);
                    startDerivedGeneration({
                        episodeId: epId,
                        shotId: sh.id,
                        recId: rec.id,
                        field: "storyboard",
                        purpose: PROCESS_PURPOSE.imageUpscale,
                        params: spec.params,
                        modelKey: spec.modelKey,
                        input: { images: [{ ...(blob?.id ? { id: blob.id } : {}), url: publicUrl, name: `${sh.title || "分镜"}·故事板` }] },
                        label: `${sh.title || "分镜"} 故事板超分（${spec.modelLabel}）`,
                    });
                } catch (err) {
                    markDerivedFail(sh.id, "sbDerived", rec.id, err instanceof Error ? err.message : "提交失败");
                }
            })();
            return;
        }
        const derived = sh.videoDerived || [];
        const uris = sh.videoUris || [];
        // 定位被处理记录：优先选中标识（占位期同 uri 凭 uri 分不清），回退 uri 匹配（原始记录优先）。
        const akRaw = sh.videoActiveKey;
        const akRec = akRaw?.startsWith("d:") ? derived.find((d) => d.id === akRaw.slice(2)) : undefined;
        const rootOf = (label: string) => parseInt(label.match(/^v(\d+)/)?.[1] || "1", 10);
        let inputUri = uri;   // 实际处理输入（发往火山 MediaKit 的源文件）
        let rootN: number;    // 标号里的 n
        let srcLabel: string; // 输入记录的标号（展示用）
        const baseIdx = uris.indexOf(uri);
        if (akRec && akRec.uri === uri) {
            inputUri = akRec.uri; rootN = rootOf(akRec.label); srcLabel = akRec.label;
        } else if (baseIdx >= 0) {
            rootN = baseIdx + 1; srcLabel = `v${baseIdx + 1}`;
        } else {
            const dRec = derived.find((d) => d.uri === uri);
            if (dRec) { inputUri = dRec.uri; rootN = rootOf(dRec.label); srcLabel = dRec.label; }
            else { rootN = 1; srcLabel = "v1"; }
        }
        const label = `v${rootN}${mode === "upscale" ? "+" : "-"}`;
        const rec: VideoDerivedRecord = {
            id: `vd-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
            kind: mode,
            uri: "", // 处理完成后由 applyDerivedResult 写入产物本地 uri
            srcUri: inputUri,
            srcLabel,
            label,
            createdAt: Date.now(),
            params: spec.params,
            modelKey: spec.modelKey,
            status: "running",
        };
        // 同标号唯一（标号取决于最后一次处理）：对 v1+ 去字幕产生的新 v1- 覆盖旧 v1-，不追加重复
        update(sh.id, { videoDerived: [...derived.filter((d) => d.label !== label), rec] });
        // 异步：源视频公网化（本地直链先上传 OSS）→ 提交处理任务（持久化在途，重启可找回）
        void (async () => {
            const markFail = (msg: string) => {
                const cur = useProjectStore.getState().episodes.find((e) => e.id === epId)?.shots.find((s) => s.id === sh.id);
                if (!cur?.videoDerived?.some((d) => d.id === rec.id)) return;
                useProjectStore.getState().updateShot(epId, sh.id, {
                    videoDerived: cur.videoDerived!.map((d) => (d.id === rec.id ? { ...d, status: "failed" as const, error: msg } : d)),
                });
            };
            try {
                const publicUrl = await ensurePublicUrl(inputUri, `${sh.title || "分镜"}·${srcLabel}`);
                if (!publicUrl) { markFail("源视频公网化失败（上传 OSS 未成功），请重试"); return; }
                const blob = useProjectStore.getState().blobByUri(inputUri);
                startDerivedGeneration({
                    episodeId: epId,
                    shotId: sh.id,
                    recId: rec.id,
                    purpose: PROCESS_PURPOSE[mode],
                    params: spec.params,
                    modelKey: spec.modelKey,
                    input: { videos: [{ ...(blob?.id ? { id: blob.id } : {}), url: publicUrl, name: `${sh.title || "分镜"}·${srcLabel}` }] },
                    label: `${sh.title || "分镜"} ${label}（${spec.modelLabel}）`,
                });
            } catch (err) {
                markFail(err instanceof Error ? err.message : "提交失败");
            }
        })();
    };

    // ── 样式 ──
    const cardBtn: React.CSSProperties = { padding: "5px 9px", borderRadius: 6, fontSize: 12, cursor: "pointer", border: "1px solid rgba(255,255,255,0.12)", background: "rgba(255,255,255,0.05)", color: "#fff" };
    const colBtn: React.CSSProperties = { ...cardBtn, padding: "5px 6px", fontSize: 11, textAlign: "center", width: "100%" };
    const toolBtn: React.CSSProperties = { padding: "8px 12px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer", border: "none", background: "linear-gradient(90deg,#8b5cf6,#7c3aed)", color: "#fff", alignSelf: "flex-end" };
    const ghostBtn: React.CSSProperties = { ...cardBtn, padding: "8px 12px", alignSelf: "flex-end" };
    const headCell: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: "rgba(255,255,255,0.7)", padding: "8px 10px" };
    // 提示词区顶栏内联控件（视频模型/时长/比例/分辨率）——紧凑
    // appearance:none 隐藏原生下拉箭头（节省顶栏宽度）
    const miniSel: React.CSSProperties = { background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 5, color: "#fff", fontSize: 10, padding: "2px 4px", outline: "none", cursor: "pointer", maxWidth: 110, appearance: "none", WebkitAppearance: "none", MozAppearance: "none" as React.CSSProperties["MozAppearance"], textAlignLast: "center" };
    const miniOpt: React.CSSProperties = { background: "#1f1f2e" };

    return (
        <div className="scroll-container">
            <style>{[
                "@keyframes sbspin{to{transform:rotate(360deg)}} .sb-spin{animation:sbspin .8s linear infinite}",
                // 固定行高下，所有单元格 min-height:0 → 内容不再撑开行（超出则按下规则裁剪/滚动）
                ".qj-shot-row>div{min-height:0}",
                ".qj-shot-row>div:first-child{overflow-y:auto}",   // 操作列：按键多时可滚动
                ".qj-shot-row>div:nth-child(2){overflow-y:auto}",  // 原文分段列（大框）：分格多时可滚动
                ".qj-shot-row>div:nth-child(3){overflow-y:auto}",  // 素材列：素材多时可滚动
                // 拖动手柄高亮
                ".qj-col-resize:hover,.qj-col-resize:active{background:rgba(139,92,246,0.7)}",
                ".qj-row-resize:hover,.qj-row-resize:active{background:rgba(139,92,246,0.45)}",
                // 分集行操作按钮：默认隐藏，悬停行时显示
                ".qj-ep-actions{opacity:0;transition:opacity .12s}",
                ".qj-ep-row:hover .qj-ep-actions{opacity:1}",
            ].join("")}</style>
            <div id="16_1195" className="Pixso-frame-16_1195">
                <EditorHeader title="分镜配置" />
                <div style={{ display: "flex", width: "100%", height: "calc(100% - 56px)", overflow: "hidden" }}>
                    <EditorSidebar activeTab="视频" />

                    {/* 左：分集列表（保留） */}
                    <div style={{ width: 210, flexShrink: 0, borderRight: "1px solid rgba(255,255,255,0.08)", display: "flex", flexDirection: "column", padding: 12, gap: 8, overflow: "hidden" }}>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                            <span style={{ fontWeight: 600, fontSize: 13 }}>分集列表</span>
                            <button style={cardBtn} onClick={handleAddEpisode}>+ 新建</button>
                        </div>
                        <div ref={epListScroll.ref} onScroll={epListScroll.onScroll} style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
                            {episodes.length === 0 ? (
                                <div style={{ color: "var(--muted-foreground)", fontSize: 12, padding: "24px 8px", textAlign: "center" }}>
                                    暂无分集。点「新建」添加，或先在「剧本」里完成拆分。
                                </div>
                            ) : (
                                episodes.map((ep) => (
                                    <div
                                        key={ep.id}
                                        className="qj-ep-row"
                                        onClick={() => setSelectedId(ep.id)}
                                        style={{
                                            position: "relative", padding: 10, borderRadius: 8, cursor: "pointer", border: "1px solid",
                                            borderColor: ep.id === selectedId ? "rgba(139,92,246,0.6)" : "rgba(255,255,255,0.08)",
                                            background: ep.id === selectedId ? "rgba(139,92,246,0.12)" : "transparent",
                                        }}
                                    >
                                        {renameEpId === ep.id ? (
                                            <input autoFocus value={renameEpVal} onClick={(e) => e.stopPropagation()}
                                                onChange={(e) => setRenameEpVal(e.target.value)} onBlur={commitRenameEp}
                                                onKeyDown={(e) => { if (e.key === "Enter") commitRenameEp(); if (e.key === "Escape") setRenameEpId(null); }}
                                                style={{ width: "100%", boxSizing: "border-box", background: "rgba(0,0,0,0.3)", border: "1px solid rgba(139,92,246,0.6)", borderRadius: 6, color: "#fff", fontSize: 13, padding: "3px 6px", outline: "none" }} />
                                        ) : (
                                            <div style={{ fontSize: 13, fontWeight: 500, paddingRight: 44, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={`${ep.title}（双击改名）`}
                                                onDoubleClick={(e) => { e.stopPropagation(); startRenameEp(ep); }}>{ep.title}</div>
                                        )}
                                        <div style={{ fontSize: 11, color: "var(--muted-foreground)", marginTop: 2 }}>
                                            {ep.shots.length > 0 ? `${ep.shots.length} 个分镜` : (ep.scriptText ? "未分镜" : "空")}
                                        </div>
                                        {renameEpId !== ep.id && (
                                            <div className="qj-ep-actions" style={{ position: "absolute", top: 6, right: 6, display: "flex", gap: 4 }}>
                                                <button onClick={(e) => { e.stopPropagation(); startRenameEp(ep); }} title="重命名"
                                                    style={{ border: "1px solid rgba(255,255,255,0.15)", background: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.8)", borderRadius: 5, fontSize: 11, lineHeight: 1, padding: "3px 5px", cursor: "pointer" }}>✎</button>
                                                <button onClick={(e) => { e.stopPropagation(); deleteEp(ep); }} title="删除分集"
                                                    style={{ border: "1px solid rgba(248,113,113,0.5)", background: "rgba(248,113,113,0.12)", color: "#f87171", borderRadius: 5, fontSize: 11, lineHeight: 1, padding: "3px 5px", cursor: "pointer" }}>✕</button>
                                            </div>
                                        )}
                                    </div>
                                ))
                            )}
                        </div>
                    </div>

                    {/* 右：表格工作台 */}
                    <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
                        {/* 顶部工具条：只放操作按钮；模型/模板/参数收敛进「视频设置」 */}
                        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, padding: "10px 14px", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                            <button style={{ ...toolBtn, alignSelf: "center", ...lockedStyle(activeEp?.id) }} disabled={!activeEp || epLocked(activeEp?.id)} onClick={handleSmartInfer}>
                                {epBusyLabel(activeEp?.id) ?? "智能推理"}
                            </button>
                            {epInferError(activeEp?.id) && <span style={{ fontSize: 12, color: "#f8c8c8", alignSelf: "center" }} title={epInferError(activeEp?.id)}>推理失败，请重试</span>}
                            <button style={{ ...ghostBtn, alignSelf: "center", ...lockedStyle(activeEp?.id) }} disabled={!activeEp || epLocked(activeEp?.id)} onClick={handleSplit}>
                                {epBusyLabel(activeEp?.id) ?? "智能拆分"}
                            </button>
                            {epSplitError(activeEp?.id) && <span style={{ fontSize: 12, color: "#f8c8c8", alignSelf: "center" }} title={epSplitError(activeEp?.id)}>拆分失败，请重试</span>}
                            <button style={{ ...ghostBtn, alignSelf: "center" }} disabled={!activeEp || epShotInferringCount(activeEp?.id) > 0 || epLocked(activeEp?.id)} onClick={inferAllShots}>
                                {epShotInferringCount(activeEp?.id) > 0 ? `推理中…(${epShotInferringCount(activeEp?.id)})` : "一键推理"}
                            </button>
                            <button style={{ ...ghostBtn, alignSelf: "center" }} disabled={!activeEp} onClick={handleMatchAll}>一键提取资产</button>
                            <button style={{ ...ghostBtn, alignSelf: "center" }} disabled={!activeEp} onClick={() => runAll(genStoryboard)}>一键故事板</button>
                            <div style={{ position: "relative", alignSelf: "center" }}>
                                <button style={{ ...ghostBtn, alignSelf: "center" }} disabled={!activeEp} onClick={() => setGenVideoMenu((v) => !v)}>一键视频 ▾</button>
                                {genVideoMenu && (
                                    <>
                                        <div onClick={() => setGenVideoMenu(false)} style={{ position: "fixed", inset: 0, zIndex: 49 }} />
                                        <div style={{ position: "absolute", zIndex: 50, top: "100%", left: 0, marginTop: 6, minWidth: 160, padding: 6, borderRadius: 8, border: "1px solid rgba(255,255,255,0.12)", background: "#161b26", boxShadow: "0 8px 24px rgba(0,0,0,0.5)" }}>
                                            <div onClick={() => handleGenAllVideos("all")} style={{ padding: "8px 10px", borderRadius: 6, cursor: "pointer", fontSize: 12 }}
                                                onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.06)")} onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>全部生成</div>
                                            <div onClick={() => handleGenAllVideos("odd")} style={{ padding: "8px 10px", borderRadius: 6, cursor: "pointer", fontSize: 12 }}
                                                onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.06)")} onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>奇数生成（第1、3、5…镜）</div>
                                        </div>
                                    </>
                                )}
                            </div>
                            {canvasModeEnabled && (
                                <button
                                    style={{ ...ghostBtn, alignSelf: "center", ...(canvasSynced ? { background: "rgba(34,197,94,0.14)", color: "#22c55e", borderColor: "rgba(34,197,94,0.5)" } : {}) }}
                                    disabled={!activeEp}
                                    title="把「资产 + 当前选中分集」投影成画布节点（不自动同步，仅此处手动触发）。会覆盖同名投影节点，画布手建节点不受影响。"
                                    onClick={syncEpisodeToCanvas}
                                >
                                    {canvasSynced ? "已同步本集 ✓" : "同步本集到画布"}
                                </button>
                            )}

                            {/* 标题栏当前模型信息（仅显示）：模型 + 比例/画质/分辨率 + 垫图形式（去标题、精简） */}
                            <div style={{ flex: 1, minWidth: 0, display: "flex", justifyContent: "center", alignItems: "center", gap: 12, fontSize: 12, color: "rgba(255,255,255,0.5)", overflow: "hidden", whiteSpace: "nowrap" }}>
                                <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}><b style={{ color: "#c4b5fd", fontWeight: 600 }}>{modelLabel("text")}</b></span>
                                <span style={{ color: "rgba(255,255,255,0.15)" }}>·</span>
                                <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}><b style={{ color: "#c4b5fd", fontWeight: 600 }}>{modelLabel("image")}</b><span style={{ color: "rgba(255,255,255,0.4)" }}> {imageAspect} {QUALITY_LABEL[imageQuality] || imageQuality}</span></span>
                                <span style={{ color: "rgba(255,255,255,0.15)" }}>·</span>
                                <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}><b style={{ color: "#c4b5fd", fontWeight: 600 }}>{modelLabel("video")}</b><span style={{ color: "rgba(255,255,255,0.4)" }}> {aspect} {resolution}</span></span>
                                <span style={{ color: "rgba(255,255,255,0.15)" }}>·</span>
                                <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}><b style={{ color: "#c4b5fd", fontWeight: 600 }}>{matFormLabel}</b></span>
                            </div>

                            {videoTableTemplates.length > 0 && (
                                <select
                                    value={activeTableTplId}
                                    onChange={(e) => { if (e.target.value) useSettingsStore.getState().applyVideoTableTemplate(e.target.value); }}
                                    title="快速切换已保存的表格布局（在「视频设置 → 表格布局」里新增/删除）"
                                    style={{ ...ghostBtn, alignSelf: "center", padding: "8px 10px", outline: "none", maxWidth: 160 }}
                                >
                                    <option value="" style={{ background: "#1f1f2e" }}>表格布局…</option>
                                    {videoTableTemplates.map((t) => (
                                        <option key={t.id} value={t.id} style={{ background: "#1f1f2e" }}>{t.name}</option>
                                    ))}
                                </select>
                            )}
                            <div style={{ position: "relative", alignSelf: "center" }}>
                                <button style={{ ...ghostBtn, alignSelf: "center" }} onClick={() => setVidSettingsOpen((v) => !v)}>视频设置 ▾</button>
                                {vidSettingsOpen && (
                                    <>
                                        {/* 点击遮罩关闭 */}
                                        <div onClick={() => setVidSettingsOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 49 }} />
                                        <div style={{ position: "absolute", zIndex: 50, top: "100%", right: 0, marginTop: 6, width: 300, maxHeight: "70vh", overflowY: "auto", padding: 14, borderRadius: 10, border: "1px solid rgba(255,255,255,0.12)", background: "#161b26", boxShadow: "0 8px 24px rgba(0,0,0,0.5)", display: "flex", flexDirection: "column", gap: 12 }}>
                                            {/* 单行样式：标题左 + 控件右（不再两行） */}
                                            <div style={{ fontSize: 12, fontWeight: 600, color: "#fff" }}>拆分·文本</div>
                                            <ModelPicker cap="text" label="文本模型" style={rowPicker} />
                                            {/* 图视同源开关：开启后故事板/视频共用一段「同源提示词」，提示词区单栏 */}
                                            <div style={rowSt}>
                                                <span style={rowLb}>图视同源</span>
                                                <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", color: "#fff", fontSize: 12 }} title="开启后：故事板与视频共用同一段「同源提示词」，提示词区只有单栏、图片与视频均使用它；推理走同源模板、同步到画布走同源链路（原文→图片+视频并联）。">
                                                    <input type="checkbox" checked={sameSource} onChange={(e) => setMS({ imgVideoSameSource: e.target.checked })} />图片与视频共用提示词
                                                </label>
                                            </div>
                                            {sameSource ? (
                                                <>
                                                    <TemplatePicker purpose="storyboard.unified" value={unifiedTplId} onChange={(id) => pickInferTpl({ unifiedTplId: id }, id)} label="同源推理（多卡）" style={rowPicker} />
                                                    <TemplatePicker purpose="storyboard.unifiedShot" value={unifiedSingleTplId} onChange={(id) => pickInferTpl({ unifiedSingleTplId: id }, id)} label="同源单卡模板" style={rowPicker} />
                                                </>
                                            ) : (
                                                <>
                                                    <TemplatePicker purpose="storyboard.toVideoPrompt" value={inferTplId} onChange={(id) => pickInferTpl({ inferTplId: id }, id)} label="推理提示词（多卡）" style={rowPicker} />
                                                    <TemplatePicker purpose="storyboard.singleShot" value={singleTplId} onChange={(id) => pickInferTpl({ singleTplId: id }, id)} label="单卡推理模板" style={rowPicker} />
                                                </>
                                            )}
                                            {inferAspectTag && (
                                                <div style={{ fontSize: 11, color: "#c4b5fd", lineHeight: 1.5 }}>
                                                    {`所选推理模板指定比例 ${inferAspectTag}——图像/视频比例已跟随（可在下方单独改）`}
                                                </div>
                                            )}
                                            <label style={rowSt}>
                                                <span style={rowLb}>单镜时长(秒)</span>
                                                {/* 时长档同样按当前生效视频模型下发（enum 模型如 5/10/15 只出三档），勿回退静态 4-15 全档 */}
                                                <select value={clampDurationTo(clampDuration(maxDuration), vidReq.durations)} onChange={(e) => setMS({ maxDuration: Number(e.target.value) })} style={rowCtl}>
                                                    {vidReq.durations.map((d) => <option key={d} value={d} style={{ background: "#1f1f2e" }}>{d} 秒</option>)}
                                                </select>
                                            </label>
                                            <label style={rowSt}>
                                                <span style={rowLb}>分镜数量</span>
                                                <input type="number" value={shotCount || ""} min={0} max={200} placeholder="自动"
                                                    onChange={(e) => setMS({ shotCount: Math.max(0, Number(e.target.value) || 0) })}
                                                    style={{ ...rowCtl, cursor: "text" }} />
                                            </label>

                                            <div style={{ height: 1, background: "rgba(255,255,255,0.08)" }} />
                                            <div style={{ fontSize: 12, fontWeight: 600, color: "#fff" }}>故事板·图像</div>
                                            <ModelPicker cap="image" label="故事板图像模型" style={rowPicker} />
                                            <label style={rowSt}>
                                                <span style={rowLb}>图像比例</span>
                                                {/* 比例档取共享常量 IMAGE_ASPECTS（与资产模式/画布同一份，勿再写死） */}
                                                <select value={imageAspect} onChange={(e) => setMS({ imageAspect: e.target.value })} style={rowCtl}>
                                                    {IMAGE_ASPECTS.map((a) => <option key={a.v} value={a.v} style={{ background: "#1f1f2e" }}>{ASPECT_LABELS[a.v] || a.label}</option>)}
                                                </select>
                                            </label>
                                            <label style={rowSt}>
                                                <span style={rowLb}>分辨率</span>
                                                <select value={imageResolution} onChange={(e) => setMS({ imageResolution: e.target.value })} style={rowCtl}>
                                                    {sbResOptions.map((r) => <option key={r.v} value={r.v.toUpperCase()} style={{ background: "#1f1f2e" }}>{r.label}</option>)}
                                                </select>
                                            </label>
                                            <label style={rowSt}>
                                                <span style={rowLb}>画质 <span style={{ color: "rgba(255,255,255,0.35)" }}>（size {imageSize}）</span></span>
                                                {/* 画质档取共享常量 IMAGE_QUALITIES（与资产模式/画布同一份，勿再写死） */}
                                                <select value={imageQuality} onChange={(e) => setMS({ imageQuality: e.target.value })} style={rowCtl}>
                                                    {IMAGE_QUALITIES.map((q) => <option key={q} value={q} style={{ background: "#1f1f2e" }}>{QUALITY_LABELS[q] || q}</option>)}
                                                </select>
                                            </label>

                                            <div style={{ height: 1, background: "rgba(255,255,255,0.08)" }} />
                                            <div style={{ fontSize: 12, fontWeight: 600, color: "#fff" }}>视频</div>
                                            <ModelPicker cap="video" label="视频模型" style={rowPicker} />
                                            {vidMethods.length > 1 && (
                                                <label style={rowSt}>
                                                    <span style={rowLb} title="首尾帧=首帧（故事板图或素材第1张图）+ 尾帧（素材下一张图）；单镜可在提示词区覆盖">方法</span>
                                                    <select value={vidMethod} onChange={(e) => setMS({ videoMethod: e.target.value })} style={rowCtl}>
                                                        {vidMethods.map((k) => <option key={k} value={k} style={{ background: "#1f1f2e" }}>{METHOD_LABELS[k]}</option>)}
                                                    </select>
                                                </label>
                                            )}
                                            <label style={rowSt}>
                                                <span style={rowLb}>分辨率</span>
                                                <select value={clampToOptions(resolution, vidReq.resolutions)} onChange={(e) => setMS({ resolution: e.target.value })} style={rowCtl}>
                                                    {vidReq.resolutions.map((r) => <option key={r} value={r} style={{ background: "#1f1f2e" }}>{r}</option>)}
                                                </select>
                                            </label>
                                            <label style={rowSt}>
                                                <span style={rowLb}>比例</span>
                                                <select value={clampToOptions(aspect, vidReq.aspects)} onChange={(e) => setMS({ aspect: e.target.value })} style={rowCtl}>
                                                    {vidReq.aspects.map((a) => <option key={a} value={a} style={{ background: "#1f1f2e" }}>{ASPECT_LABELS[a] || a}</option>)}
                                                </select>
                                            </label>
                                            <div style={rowSt}>
                                                <span style={rowLb}>生成视频时附带</span>
                                                <span style={{ display: "flex", gap: 14, fontSize: 12, color: "#fff" }}>
                                                    <label style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer" }}>
                                                        <input type="checkbox" checked={genWithAsset} onChange={(e) => setMS({ genWithAsset: e.target.checked })} />带资产
                                                    </label>
                                                    <label style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer" }}>
                                                        <input type="checkbox" checked={genWithStory} onChange={(e) => setMS({ genWithStory: e.target.checked })} />带故事板
                                                    </label>
                                                </span>
                                            </div>

                                            <div style={{ height: 1, background: "rgba(255,255,255,0.08)" }} />
                                            <div style={{ fontSize: 12, fontWeight: 600, color: "#fff" }}>表格布局</div>
                                            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", lineHeight: 1.5 }}>拖动表头右边界改列宽、拖动每行下边界改行高；为全局设置，跨分集/项目通用，改一次长期生效。</div>
                                            {/* #6 表格样式模板：保存当前布局为命名模板，可一键切换 */}
                                            <div style={{ display: "flex", gap: 6 }}>
                                                <input value={tplName} onChange={(e) => setTplName(e.target.value)} placeholder="模板名（如 紧凑/宽松）"
                                                    style={{ flex: 1, minWidth: 0, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 6, color: "#fff", padding: "6px 8px", fontSize: 12, outline: "none" }} />
                                                <button style={{ ...cardBtn, whiteSpace: "nowrap" }} onClick={() => { useSettingsStore.getState().saveVideoTableTemplate(tplName); setTplName(""); }}>保存当前</button>
                                            </div>
                                            {videoTableTemplates.length > 0 && (
                                                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                                                    {videoTableTemplates.map((t) => (
                                                        <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#fff" }}>
                                                            <button style={{ ...cardBtn, flex: 1, minWidth: 0, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={`套用「${t.name}」（列宽 ${t.layout.colWidths.join("/")}，行高 ${t.layout.rowHeight}）`} onClick={() => useSettingsStore.getState().applyVideoTableTemplate(t.id)}>{t.name}</button>
                                                            <button style={{ ...cardBtn, color: "#f8c8c8", padding: "5px 8px" }} title="删除该模板" onClick={() => useSettingsStore.getState().removeVideoTableTemplate(t.id)}>✕</button>
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                            <button style={{ ...ghostBtn, alignSelf: "stretch", textAlign: "center" }} onClick={() => useSettingsStore.getState().resetVideoTableLayout()}>重置表格布局</button>
                                        </div>
                                    </>
                                )}
                            </div>
                            <button style={{ ...ghostBtn, alignSelf: "center", borderColor: "rgba(139,92,246,0.5)" }} disabled={!activeEp} onClick={handleExportAll}>导出所有视频</button>
                        </div>

                        {/* 表格主体（表头与表体同处一个横向滚动容器，列宽对齐 + 横向同步滚动）*/}
                        <div ref={tableScroll.ref} onScroll={tableScroll.onScroll} style={{ flex: 1, overflow: "auto" }}>
                            {!activeEp ? (
                                <div style={{ color: "var(--muted-foreground)", fontSize: 13, padding: 40, textAlign: "center" }}>请选择左侧分集</div>
                            ) : activeEp.shots.length === 0 && !epInferring(activeEp.id) && !epSplitting(activeEp.id) ? (
                                // 未推理/未拆分且未在生成：本集原文输入（宽高铺满）+ 智能推理/智能拆分 + 设置（模型）
                                <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10, minHeight: "100%", boxSizing: "border-box" }}>
                                    <span style={{ fontWeight: 600, fontSize: 14 }}>本集剧本原文</span>
                                    <textarea
                                        placeholder="粘贴/输入本集剧本内容，然后点下方「智能推理」一次生成分镜 + 故事板提示词 + 视频提示词；或「智能拆分」仅拆出镜头再逐镜推理"
                                        value={activeEp.scriptText || ""}
                                        onChange={(e) => useProjectStore.getState().updateEpisode(activeEp.id, { scriptText: e.target.value })}
                                        style={{ flex: 1, width: "100%", boxSizing: "border-box", minHeight: 320, resize: "none", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, color: "#fff", fontSize: 13, padding: 12, outline: "none", lineHeight: 1.7 }}
                                    />

                                    {/* 推理设置：文本模型 + 推理提示词 + 智能推理 */}
                                    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: 12, padding: "12px 14px", borderRadius: 10, border: "1px solid rgba(255,255,255,0.1)", background: "rgba(255,255,255,0.02)" }}>
                                        <div style={{ minWidth: 180 }}>
                                            <ModelPicker cap="text" label="文本模型" />
                                        </div>
                                        <div style={{ minWidth: 200 }}>
                                            {sameSource
                                                ? <TemplatePicker purpose="storyboard.unified" value={unifiedTplId} onChange={(id) => pickInferTpl({ unifiedTplId: id }, id)} label="同源推理" />
                                                : <TemplatePicker purpose="storyboard.toVideoPrompt" value={inferTplId} onChange={(id) => pickInferTpl({ inferTplId: id }, id)} label="推理提示词" />}
                                        </div>
                                        <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", color: "rgba(255,255,255,0.8)", fontSize: 12, alignSelf: "flex-end", paddingBottom: 8 }} title="图片与视频共用同一段提示词（同源）">
                                            <input type="checkbox" checked={sameSource} onChange={(e) => setMS({ imgVideoSameSource: e.target.checked })} />图视同源
                                        </label>
                                        <button style={{ ...toolBtn, alignSelf: "flex-end", ...lockedStyle(activeEp.id) }} disabled={epLocked(activeEp.id)} onClick={handleSmartInfer}>
                                            {epBusyLabel(activeEp.id) ?? "智能推理"}
                                        </button>
                                        <button style={{ ...ghostBtn, alignSelf: "flex-end", ...lockedStyle(activeEp.id) }} disabled={epLocked(activeEp.id)} onClick={handleSplit}>
                                            {epBusyLabel(activeEp.id) ?? "智能拆分"}
                                        </button>
                                    </div>
                                    {epInferError(activeEp.id) && <span style={{ fontSize: 12, color: "#f8c8c8" }}>上次推理失败：{epInferError(activeEp.id)}</span>}
                                    {epSplitError(activeEp.id) && <span style={{ fontSize: 12, color: "#f8c8c8" }}>上次拆分失败：{epSplitError(activeEp.id)}</span>}
                                    <span style={{ fontSize: 12, color: "var(--muted-foreground)" }}>提示：智能推理一次出分镜 + 故事板提示词 + 视频提示词；智能拆分仅拆镜头（提示词在服务端配置），再用「一键推理」逐镜补提示词。</span>
                                </div>
                            ) : (
                                <div style={{ minWidth: tableMinW }}>
                                    {/* 粘性表头：每列右边界可拖动改列宽（全局记忆）*/}
                                    <div style={{ display: "grid", gridTemplateColumns: gridCols, position: "sticky", top: 0, zIndex: 5, background: "#101218", borderBottom: "1px solid rgba(255,255,255,0.12)" }}>
                                        {COL_LABELS.map((label, ci) => (
                                            <div key={label} style={{ ...headCell, position: "relative", userSelect: "none" }}>
                                                {label}
                                                <div
                                                    onMouseDown={(e) => startColResize(ci, e)}
                                                    title="拖动调整列宽"
                                                    className="qj-col-resize"
                                                    style={{ position: "absolute", top: 0, right: 0, width: 8, height: "100%", cursor: "col-resize", zIndex: 6 }}
                                                />
                                            </div>
                                        ))}
                                    </div>
                                    {activeEp.shots.length === 0 && (epInferring(activeEp.id) || epSplitting(activeEp.id)) && (
                                        <div style={{ padding: 40, textAlign: "center", color: "var(--muted-foreground)", fontSize: 13 }}>
                                            {epSplitting(activeEp.id) ? "智能拆分中，镜头将陆续出现…" : "智能推理中，分镜将陆续出现，可边出边审核…"}
                                        </div>
                                    )}
                                    {activeEp.shots.map((shot, idx) => {
                                        const tab = tabOf(shot.id);
                                        // 单卡模型：家族 → 渠道/线路 → 模型 → 方法 → 要求（第163轮五级，家族=一级筛选）
                                        const curVideoModel = shot.overrides?.videoModelKey || effectiveModelKey("video") || "";
                                        const curFamGrp = familyOf(curVideoModel, videoFamilies);
                                        const curFamChs = curFamGrp?.channels ?? [];
                                        const curSrcCh = channelOf(curVideoModel, curFamChs);
                                        // curCatModel 只用于 officialAssets（真人图，catalog 专属字段）；档位/方法一律走 modelOptions
                                        const curCatModel = sbModels?.find((m) => m.id === curVideoModel);
                                        const curMethods = modelMethodsForKey(curVideoModel);
                                        const curMethod = clampMethod(shot.overrides?.method || ms.videoMethod, curMethods);
                                        const curReq = videoReqOptionsForKey(curVideoModel);
                                        // 图视同源：提示词区单栏（字段=unifiedPrompt），无故事板/视频切换；否则按 tab 取两段之一
                                        const promptVal = sameSource ? (shot.unifiedPrompt || "") : (tab === "storyboard" ? (shot.storyboardPrompt || "") : (shot.videoPrompt || ""));
                                        const promptBaseVal = sameSource ? shot.unifiedPromptBase : (tab === "storyboard" ? shot.storyboardPromptBase : shot.videoPromptBase);
                                        const promptTabKey: PromptTab | "unified" = sameSource ? "unified" : tab;
                                        const promptPatch = (v: string): Partial<StoryboardShot> => sameSource ? { unifiedPrompt: v } : (tab === "storyboard" ? { storyboardPrompt: v } : { videoPrompt: v });
                                        const sbHist = shot.storyboardImages || [];
                                        const sbDerivedL = shot.sbDerived || [];
                                        const vidHist = shot.videoUris || [];
                                        const vidDerived = shot.videoDerived || [];
                                        // 选中记录标识：与当前主视频对得上才生效（新生成直接改 videoUri 时自动失效→回退 uri 比较）
                                        const akRaw = shot.videoActiveKey;
                                        const akUri = akRaw?.startsWith("d:") ? vidDerived.find((d) => d.id === akRaw.slice(2))?.uri
                                            : akRaw?.startsWith("u:") ? akRaw.slice(2) : undefined;
                                        const ak = akUri !== undefined && akUri === shot.videoUri ? akRaw : undefined;
                                        const matTags = materialTags(shot.materials); // 素材 → @ImageN/@VideoN/@AudioN
                                        return (
                                            <div key={shot.id} className="qj-shot-row" style={{ display: "grid", gridTemplateColumns: gridCols, alignItems: "stretch", borderBottom: "1px solid rgba(255,255,255,0.06)", background: idx % 2 ? "rgba(255,255,255,0.015)" : "transparent", height: rowHeight, overflow: "hidden", position: "relative" }}>
                                                {/* 1. 操作（首列）*/}
                                                <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 5, borderRight: "1px solid rgba(255,255,255,0.05)" }}>
                                                    <span style={{ fontSize: 12, fontWeight: 600 }}>{shot.title || `分镜${idx + 1}`}{shot.durationSec ? <span style={{ fontWeight: 400, color: "var(--muted-foreground)" }}>·{shot.durationSec}s</span> : null}</span>
                                                    <div style={{ display: "flex", gap: 4 }}>
                                                        <button style={colBtn} title="上拆：把本镜第一格（首行）移到上一镜末尾" onClick={() => splitMove(idx, "up")}>上拆</button>
                                                        <button style={colBtn} title="下拆：把本镜最后一格（末行）移到下一镜开头" onClick={() => splitMove(idx, "down")}>下拆</button>
                                                    </div>
                                                    <div style={{ display: "flex", gap: 4 }}>
                                                        <button style={colBtn} onClick={() => addShotAt(idx, "above")}>上增</button>
                                                        <button style={colBtn} onClick={() => addShotAt(idx, "below")}>下增</button>
                                                    </div>
                                                    <button style={colBtn} onClick={() => handleMatchOne(shot)}>提取资产</button>
                                                    <button style={colBtn} title="对本分镜单卡推理：一次产出本镜的 故事板提示词 + 视频提示词" disabled={shotInferring(shot.id)} onClick={() => inferShot(shot)}>{shotInferring(shot.id) ? "推理中…" : "智能推理"}</button>
                                                    <button style={{ ...colBtn, color: "#f8c8c8", marginTop: "auto" }} onClick={() => { void (async () => { if (await confirmDialog(`删除${shot.title || "本分镜"}？`)) commitShots(activeEp.shots.filter((x) => x.id !== shot.id)); })(); }}>删除分镜</button>
                                                </div>

                                                {/* 2. 原文分段（分格显示：每格=一行/一段，以换行为界；默认只读，右击进入编辑模式）
                                                    大框套小框：列自身可滚动（nth-child(2) overflow-y），每个分格固定上限高度、超出内部滚动。*/}
                                                <div className="Qiji-scroll-thin" style={{ padding: 10, display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}
                                                    onContextMenu={(e) => { e.preventDefault(); setSegMenu({ shotId: shot.id, x: e.clientX, y: e.clientY }); }}>
                                                    {segEdit[shot.id] ? (
                                                        <>
                                                            <div style={{ fontSize: 10, color: "#f5c451" }}>编辑中（右键可退出编辑模式）</div>
                                                            <HighlightEditable
                                                                value={shot.scriptSegment ?? shot.prompt ?? ""}
                                                                onChange={(v) => update(shot.id, { scriptSegment: v })}
                                                                terms={assetHighlightTerms}
                                                                placeholder="本大分镜原文（换行=分格，空行不算分格不外显；每行可被向上/下拆迁移；提取到的资产会在此高亮）"
                                                            />
                                                        </>
                                                    ) : (() => {
                                                        const raw = shot.scriptSegment ?? shot.prompt ?? "";
                                                        if (!raw.trim()) return <div style={{ fontSize: 11, color: "var(--muted-foreground)" }}>本段暂无原文（右击进入编辑模式可添加）</div>;
                                                        // 空行不是分格：外显跳过（编辑模式仍显示原文全貌；上拆/下拆同样按非空行迁移）
                                                        return raw.split(/\r?\n/).filter((line) => line.trim()).map((line, li) => (
                                                            <div key={li} title="右击进入编辑模式；上拆/下拆移动一个分格" className="Qiji-scroll-thin"
                                                                style={{ border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6, padding: "6px 8px", fontSize: 12, lineHeight: 1.6, color: "#e7e7ee", background: "rgba(255,255,255,0.03)", minHeight: 18, maxHeight: 84, overflowY: "auto", flexShrink: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                                                                {highlightSegment(line, assetHighlightTerms)}
                                                            </div>
                                                        ));
                                                    })()}
                                                </div>

                                                {/* 3. 素材区 */}
                                                <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 6, position: "relative" }}
                                                    onDragOver={(e) => e.preventDefault()} onDrop={(e) => onMaterialDrop(shot, e)}>
                                                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                                                        {shot.materials.map((m) => {
                                                            const md = mediaOf(m);
													const imageIndex = md === "image" ? shot.materials.filter((x) => mediaOf(x) === "image").findIndex((x) => x.id === m.id) : -1;
													const identity = imageIndex >= 0 && isIdentityShotMaterial(m, imageIndex, shot.overrides?.officialAssetIndexes);
                                                            const verdict = matValid[m.id];
                                                            const bad = !matError[m.id] && !!m.uri && verdict && !verdict.ok;
                                                            return (
                                                                <div key={m.id}
                                                                    className={bad ? "qj-mat-cell" : undefined}
                                                                    title={matError[m.id] ? `${m.name}：上传失败（右键删除后重试）` : bad ? `⚠ ${m.name} 违规：\n· ${(verdict?.reasons || []).join("\n· ")}\n（悬停查看原素材 / 右键删除）` : `${matTags[m.id]} ${KIND_LABEL[m.kind]}·${m.name}（双击放大 / 右键删除 / 拖动排序）`}
                                                                    draggable
                                                                    onDragStart={(e) => { dragMat.current = { shotId: shot.id, matId: m.id }; e.dataTransfer.setData("application/x-qiji-matreorder", m.id); e.dataTransfer.effectAllowed = "move"; }}
                                                                    onDragEnd={() => { dragMat.current = null; }}
                                                                    onDragOver={(e) => { if (dragMat.current && dragMat.current.shotId === shot.id && dragMat.current.matId !== m.id) { e.preventDefault(); e.stopPropagation(); } }}
                                                                    onDrop={(e) => { if (dragMat.current && dragMat.current.shotId === shot.id) { e.preventDefault(); e.stopPropagation(); reorderMaterials(shot, dragMat.current.matId, m.id); dragMat.current = null; } }}
                                                                    onDoubleClick={() => m.uri && openLightbox({ uri: m.uri, media: md, name: m.name })}
                                                                    onContextMenu={(e) => { e.preventDefault(); removeMaterial(shot, m.id); }}
                                                                    style={{ position: "relative", width: 40, height: 40, borderRadius: 6, overflow: "hidden", border: (matError[m.id] || bad) ? "1px solid #f87171" : "1px solid rgba(255,255,255,0.12)", background: matError[m.id] ? "rgba(248,113,113,0.18)" : "rgba(255,255,255,0.05)", cursor: m.uri ? "grab" : "default", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, color: "var(--muted-foreground)", textAlign: "center" }}>
                                                                    {matError[m.id] ? <span style={{ color: "#f87171", fontSize: 18, fontWeight: 700 }}>✕</span>
                                                                        : m.uri ? (
                                                                            md === "video" ? <video src={m.uri} muted preload="metadata" style={{ width: "100%", height: "100%", objectFit: "cover", pointerEvents: "none" }} />
                                                                                : md === "audio" ? <span style={{ fontSize: 18 }}>🎵</span>
                                                                                    : <img src={m.uri} alt={m.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                                                                        ) : m.name.slice(0, 4)}
                                                                    {/* 左上角 @tag 角标（I1/V1/A1，按模态配色），标明该素材在提示词里的引用编号 */}
                                                                    <span style={{ position: "absolute", top: 0, left: 0, fontSize: 8, lineHeight: "12px", padding: "0 3px", borderBottomRightRadius: 4, background: BADGE_BG[md], color: "#fff", fontWeight: 700 }}>{TAG_BADGE[md]}{matTags[m.id].replace(/^@\D+/, "")}</span>
                                                                    {/* 视频角标：右下角播放小三角 */}
                                                                    {md === "video" && !matError[m.id] && <span style={{ position: "absolute", right: 1, bottom: 1, fontSize: 9, color: "#fff", textShadow: "0 0 3px #000" }}>▶</span>}
														{curCatModel?.officialAssets && md === "image" && !matError[m.id] && (
															<IdentityAssetToggle active={identity} onToggle={() => setShotMaterialIdentity(activeEp.id, shot.id, m.id, !identity)} />
														)}
                                                                    {uploading[m.id] && <span style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.55)" }}><span className="sb-spin" style={{ display: "inline-block", color: "#fff", fontSize: 15 }}>↻</span></span>}
                                                                    {/* 违规红色遮罩 + ❗（悬停时由 CSS .qj-mat-cell:hover 隐藏，方便查看原素材）*/}
                                                                    {bad && <span className="qj-mat-badmask" style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(239,68,68,0.72)", color: "#fff", fontSize: 20, fontWeight: 800, pointerEvents: "none" }}>❗</span>}
                                                                </div>
                                                            );
                                                        })}
                                                        <button onClick={(e) => {
                                                            if (addingShotId === shot.id) { setAddingShotId(null); return; }
                                                            const r = e.currentTarget.getBoundingClientRect();
                                                            setAddAnchor({ x: r.left, y: r.bottom });
                                                            setAddingShotId(shot.id);
                                                        }}
                                                            style={{ width: 40, height: 40, borderRadius: 6, border: "1px dashed rgba(255,255,255,0.25)", background: "transparent", color: "var(--muted-foreground)", cursor: "pointer", fontSize: 18 }}>+</button>
                                                    </div>
                                                    {/* 素材弹层用固定定位（避开行 overflow:hidden 裁剪）+ 透明遮罩点击外部关闭 */}
                                                    {addingShotId === shot.id && addAnchor && (
                                                        <>
                                                            <div onClick={() => setAddingShotId(null)} style={{ position: "fixed", inset: 0, zIndex: 39 }} />
                                                            <div style={{ position: "fixed", zIndex: 40, top: Math.min(addAnchor.y + 4, window.innerHeight - 250), left: Math.min(addAnchor.x, window.innerWidth - 236), width: 224, border: "1px solid rgba(255,255,255,0.12)", borderRadius: 8, padding: 8, background: "#161b26", maxHeight: 240, overflowY: "auto", boxShadow: "0 8px 24px rgba(0,0,0,0.5)" }}>
                                                                <label style={{ ...cardBtn, display: "block", textAlign: "center", marginBottom: 6 }}>
                                                                    本地上传（图/视频/音频）
                                                                    <input type="file" accept="image/*,video/*,audio/*" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) void addLocalMaterial(shot, f); e.target.value = ""; }} />
                                                                </label>
                                                                {assetPool.length === 0 ? (
                                                                    <div style={{ fontSize: 11, color: "var(--muted-foreground)" }}>资产库为空</div>
                                                                ) : assetPool.map((a) => (
                                                                    <div key={a.assetId} onClick={() => addAssetMaterial(shot, a)} style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 6px", borderRadius: 6, cursor: "pointer", fontSize: 12 }}
                                                                        onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.06)")}
                                                                        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                                                                        <span style={{ width: 22, height: 22, borderRadius: 4, overflow: "hidden", background: "rgba(255,255,255,0.08)", flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 8 }}>
                                                                            {a.uri ? <img src={a.uri} style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : KIND_LABEL[a.kind]}
                                                                        </span>
                                                                        <span style={{ color: "var(--muted-foreground)" }}>[{KIND_LABEL[a.kind]}]</span>{a.name}
                                                                    </div>
                                                                ))}
                                                            </div>
                                                        </>
                                                    )}
                                                </div>

                                                {/* 4. 提示词区（切换：故事板 / 视频；宽高撑满；@素材插入引用）*/}
                                                <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 6, minWidth: 0, position: "relative" }}>
                                                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                                                    {/* 第一行：提示词类型 + 预设方案 + 补镜头 */}
                                                    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                                                        {sameSource ? (
                                                            // 图视同源：单栏（图片与视频共用），无切换 tab
                                                            <div style={{ display: "inline-flex", alignItems: "center", padding: "4px 10px", fontSize: 11, borderRadius: 6, border: "1px solid rgba(139,92,246,0.4)", background: "rgba(139,92,246,0.18)", color: "#c9b8ff", width: "fit-content" }} title="图视同源：图片与视频共用同一段提示词">同源提示词</div>
                                                        ) : (
                                                            <div style={{ display: "inline-flex", borderRadius: 6, overflow: "hidden", border: "1px solid rgba(255,255,255,0.12)", width: "fit-content" }}>
                                                                {(["storyboard", "video"] as PromptTab[]).map((t) => (
                                                                    <button key={t} onClick={() => setPromptTab((p) => ({ ...p, [shot.id]: t }))}
                                                                        style={{ padding: "4px 10px", fontSize: 11, cursor: "pointer", border: "none", background: tab === t ? "rgba(139,92,246,0.35)" : "transparent", color: "#fff" }}>
                                                                        {t === "storyboard" ? "故事板提示词" : "视频提示词"}
                                                                    </button>
                                                                ))}
                                                            </div>
                                                        )}
                                                        {/* 预设方案：点击插入预设胶囊到当前提示词光标处，提交时展开为完整预设词，双击胶囊可展开为可编辑文本 */}
                                                        {presetSchemes.length > 0 && (
                                                            <button title="插入出图预设方案（提交时替换为完整预设词；双击胶囊可展开为可编辑文本）"
                                                                onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setPresetShot(presetShot?.shotId === shot.id ? null : { shotId: shot.id, x: r.left, y: r.bottom }); }}
                                                                style={{ padding: "3px 8px", fontSize: 11, cursor: "pointer", borderRadius: 6, border: "1px solid rgba(245,158,11,0.4)", background: presetShot?.shotId === shot.id ? "rgba(245,158,11,0.22)" : "rgba(245,158,11,0.12)", color: "#fcd34d" }}>▦ 预设方案</button>
                                                        )}
                                                        {/* 补镜头开关（#14）。@素材按钮已删——仍可在提示词里输入 @ 选素材 */}
                                                        <button title="补镜头：本镜编号派生自上一主镜（如「分镜3」→「分镜3-1」），影响命名/导出"
                                                            onClick={() => toggleSupplement(shot)}
                                                            style={{ padding: "3px 8px", fontSize: 11, cursor: "pointer", borderRadius: 6, border: shot.isSupplement ? "1px solid rgba(245,196,81,0.7)" : "1px solid rgba(255,255,255,0.18)", background: shot.isSupplement ? "rgba(245,196,81,0.18)" : "transparent", color: shot.isSupplement ? "#f5c451" : "rgba(255,255,255,0.7)" }}>补镜头</button>
                                                    </div>
                                                    {/* 第二行：家族 → 渠道/线路 → 模型 → 时长/比例/分辨率 → 放大（第163轮，与画布一致的 家族|线路|模型|要求） */}
                                                    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                                                        {/* 家族（模型种类：Seedance 2.0 / Sora2 / Grok…） */}
                                                        <select title="模型家族（模型种类，仅本分镜）" value={curFamGrp ? `f:${curFamGrp.familyId}` : ""} onChange={(e) => { if (e.target.value) setShotVideoModel(shot, modelForFamily(e.target.value.slice(2), curVideoModel, videoFamilies)); }} style={miniSel}>
                                                            {!curFamGrp && <option value="" style={miniOpt}>未选模型</option>}
                                                            {videoFamilies.map((f) => <option key={f.familyId} value={`f:${f.familyId}`} style={miniOpt}>{f.familyName}</option>)}
                                                        </select>
                                                        {/* 渠道/线路（家族内的源：模式名 / LibTV / 即梦） */}
                                                        {curFamGrp && (
                                                            <select title="渠道/线路（仅本分镜）" value={curSrcCh ? sourceValueOf(curVideoModel, curFamChs) : ""} onChange={(e) => setShotVideoModel(shot, modelForSource(e.target.value, curVideoModel, curFamChs))} style={miniSel}>
                                                                {curFamChs.map((ch) => <option key={ch.channel} value={`src:${ch.channel}`} style={miniOpt}>{ch.channel}</option>)}
                                                            </select>
                                                        )}
                                                        {/* 模型（本线路内的款式） */}
                                                        {curSrcCh && (
                                                            <select title="模型（本线路款式，仅本分镜）" value={curVideoModel} onChange={(e) => setShotVideoModel(shot, e.target.value)} style={miniSel}>
                                                                {curSrcCh.choices.map((v) => <option key={v.id} value={v.id} style={miniOpt}>{v.variantLabel}</option>)}
                                                            </select>
                                                        )}
                                                        {/* 方法（第131轮）：模型声明多方法才显示（全能参考/首尾帧——首尾帧=故事板图/素材图1 作首帧、素材下一图作尾帧） */}
                                                        {curMethods.length > 1 && (
                                                            <select title="方法（仅本分镜）：首尾帧=首帧（故事板图或素材第1张图）+ 尾帧（素材下一张图）" value={curMethod} onChange={(e) => setShotOverride(shot, { method: e.target.value })} style={miniSel}>
                                                                {curMethods.map((k) => <option key={k} value={k} style={miniOpt}>{METHOD_LABELS[k]}</option>)}
                                                            </select>
                                                        )}
                                                        <select title="视频时长(秒，仅本分镜)" value={clampDurationTo(clampDuration(shot.durationSec ?? maxDuration), curReq.durations)} onChange={(e) => update(shot.id, { durationSec: Number(e.target.value) })} style={miniSel}>
                                                            {curReq.durations.map((d) => <option key={d} value={d} style={miniOpt}>{d}秒</option>)}
                                                        </select>
                                                        <select title="视频比例（仅本分镜）" value={clampToOptions(shot.overrides?.aspect || aspect, curReq.aspects)} onChange={(e) => setShotOverride(shot, { aspect: e.target.value })} style={miniSel}>
                                                            {curReq.aspects.map((a) => <option key={a} value={a} style={miniOpt}>{a}</option>)}
                                                        </select>
                                                        <select title="视频分辨率（仅本分镜）" value={clampToOptions(shot.overrides?.resolution || resolution, curReq.resolutions)} onChange={(e) => setShotOverride(shot, { resolution: e.target.value })} style={miniSel}>
                                                            {curReq.resolutions.map((r) => <option key={r} value={r} style={miniOpt}>{r}</option>)}
                                                        </select>
                                                        {/* 放大编辑当前 tab 的提示词，置于顶栏最右，避开提示词框滚动条 */}
                                                        <PromptExpandButton
                                                            title={sameSource ? "编辑同源提示词" : tab === "storyboard" ? "编辑故事板提示词" : "编辑视频提示词"}
                                                            getValue={() => promptVal}
                                                            onSave={(v) => update(shot.id, promptPatch(v))}
                                                            getExtra={() => <ShotMaterialStrip episodeId={activeEp.id} shotId={shot.id} identityEnabled={!!curCatModel?.officialAssets} />}
                                                            getMentions={() => {
                                                                const mats = useProjectStore.getState().episodes.find((e) => e.id === activeEp.id)?.shots.find((s) => s.id === shot.id)?.materials ?? [];
                                                                const tg = materialTags(mats);
                                                                return mats.map((m) => ({ tag: tg[m.id], name: m.name, uri: m.uri, media: mediaOf(m) }));
                                                            }}
                                                            onImport={(cand) => importAssetToShot(activeEp.id, shot.id, cand)}
                                                            getPresets={presetSchemes.length ? () => presetSchemes : undefined}
                                                            onMatchAssets={(draft) => {
                                                                // 复用本页「提取资产」同一实现（含音色声音参考+图例），以弹窗草稿为当前栏提示词
                                                                const findShot = () => useProjectStore.getState().episodes.find((e) => e.id === activeEp.id)?.shots.find((s) => s.id === shot.id);
                                                                const live = findShot() ?? shot;
                                                                const beforeCount = live.materials.length;
                                                                if (!matchAssets(live, { tab: promptTabKey, text: draft })) return null;
                                                                const after = findShot();
                                                                if (!after) return null;
                                                                const p = (sameSource ? after.unifiedPrompt : (tab === "storyboard" ? after.storyboardPrompt : after.videoPrompt)) || "";
                                                                return { prompt: p, added: Math.max(0, after.materials.length - beforeCount) };
                                                            }}
                                                            style={{ marginLeft: "auto" }}
                                                        />
                                                    </div>
                                                  </div>
                                                    <PromptMentionEditor
                                                        ref={(h) => { promptRefs.current[shot.id] = h; }}
                                                        value={promptVal}
                                                        diffBase={promptBaseVal}
                                                        materials={shot.materials}
                                                        presets={presetSchemes}
                                                        onChange={(text) => update(shot.id, promptPatch(text))}
                                                        onMentionProbe={(pos) => {
                                                            if (pos) setMentionShot({ shotId: shot.id, x: pos.x, y: pos.y, viaAt: true });
                                                            else setMentionShot((cur) => (cur?.shotId === shot.id && cur.viaAt ? null : cur));
                                                        }}
                                                        onImportProbe={(pos) => {
                                                            if (pos) setImportShot({ shotId: shot.id, x: pos.x, y: pos.y });
                                                            else setImportShot((cur) => (cur?.shotId === shot.id ? null : cur));
                                                        }}
                                                        onPasteMedia={(files) => { files.forEach((f) => void addLocalMaterial(shot, f)); }}
                                                        placeholder={sameSource ? "同源提示词（图片与视频共用）— 由「智能推理」生成，可在此编辑" : tab === "storyboard" ? "故事板图像提示词（喂图像模型）— 由「智能推理」生成，可在此编辑" : "视频提示词（喂视频模型）— 由「智能推理」生成，可在此编辑"}
                                                        style={{ flex: 1, minHeight: 0, width: "100%", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6, color: "#e7e7ee", fontSize: 12, padding: 8, lineHeight: 1.6 }}
                                                    />
                                                    {/* @素材引用下拉：列出本分镜素材，选中即在光标处插入缩略图胶囊（固定定位，避开行裁剪）*/}
                                                    {mentionShot?.shotId === shot.id && (
                                                        <>
                                                            <div onClick={() => setMentionShot(null)} style={{ position: "fixed", inset: 0, zIndex: 41 }} />
                                                            <div style={{ position: "fixed", zIndex: 42, top: Math.min(mentionShot.y + 4, window.innerHeight - 260), left: Math.max(8, Math.min(mentionShot.x - 220, window.innerWidth - 232)), width: 220, border: "1px solid rgba(255,255,255,0.12)", borderRadius: 8, padding: 8, background: "#161b26", maxHeight: 250, overflowY: "auto", boxShadow: "0 8px 24px rgba(0,0,0,0.5)" }}>
                                                                {shot.materials.length === 0 ? (
                                                                    <div style={{ fontSize: 11, color: "var(--muted-foreground)" }}>本分镜暂无素材，先在素材区添加</div>
                                                                ) : shot.materials.map((m) => (
                                                                    <div key={m.id} onMouseDown={(ev) => ev.preventDefault()} onClick={() => insertMention(shot, m)} style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 6px", borderRadius: 6, cursor: "pointer", fontSize: 12 }}
                                                                        onMouseEnter={(ev) => (ev.currentTarget.style.background = "rgba(255,255,255,0.06)")}
                                                                        onMouseLeave={(ev) => (ev.currentTarget.style.background = "transparent")}>
                                                                        <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: 4, background: BADGE_BG[mediaOf(m)], color: "#fff", flexShrink: 0 }}>{matTags[m.id]}</span>
                                                                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.name}</span>
                                                                    </div>
                                                                ))}
                                                            </div>
                                                        </>
                                                    )}
                                                    {/* # 导入资产待选框：选中 → 加入本镜素材区 + 光标处 @ 引用（# 被吃掉）*/}
                                                    {importShot?.shotId === shot.id && (
                                                        <AssetImportDropdown
                                                            pos={{ x: importShot.x, y: importShot.y }}
                                                            onClose={() => setImportShot(null)}
                                                            onPick={(cand) => importMention(shot, cand)}
                                                        />
                                                    )}
                                                    {/* 预设方案下拉：选中即在当前提示词光标处插入预设胶囊 */}
                                                    {presetShot?.shotId === shot.id && presetSchemes.length > 0 && (
                                                        <>
                                                            <div onClick={() => setPresetShot(null)} style={{ position: "fixed", inset: 0, zIndex: 41 }} />
                                                            <div style={{ position: "fixed", zIndex: 42, top: Math.min(presetShot.y + 4, window.innerHeight - 320), left: Math.max(8, Math.min(presetShot.x, window.innerWidth - 300)), width: 288, border: "1px solid rgba(255,255,255,0.12)", borderRadius: 10, padding: 4, background: "#161b26", maxHeight: 300, overflowY: "auto", boxShadow: "0 8px 24px rgba(0,0,0,0.5)" }}>
                                                                {presetSchemes.map((p) => (
                                                                    <div key={p.id} onMouseDown={(ev) => ev.preventDefault()}
                                                                        onClick={() => { promptRefs.current[shot.id]?.insertPreset(p.id, p.name); setPresetShot(null); }}
                                                                        style={{ padding: "6px 8px", borderRadius: 6, cursor: "pointer" }}
                                                                        onMouseEnter={(ev) => (ev.currentTarget.style.background = "rgba(255,255,255,0.06)")}
                                                                        onMouseLeave={(ev) => (ev.currentTarget.style.background = "transparent")}>
                                                                        <div style={{ fontSize: 12, color: "#fcd34d", fontWeight: 600 }}>▦ {p.name}</div>
                                                                        <div style={{ fontSize: 10, color: "rgba(255,255,255,0.5)", marginTop: 2, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{p.body}</div>
                                                                    </div>
                                                                ))}
                                                            </div>
                                                        </>
                                                    )}
                                                </div>

                                                {/* 5. 故事板区（主图撑满 + 历史记录 + 生成）*/}
                                                <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 6 }}>
                                                    <div style={{ flex: 1, minHeight: 120, borderRadius: 8, border: "1px solid rgba(255,255,255,0.1)", background: "rgba(0,0,0,0.25)", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
                                                        {shot.storyboardUri ? (
                                                            <img src={shot.storyboardUri} alt={shot.title} title="双击放大 / 右键菜单（导出、加入相邻镜）"
                                                                onDoubleClick={() => openLightbox({ uri: shot.storyboardUri!, media: "image", name: `${shot.title || "分镜"}·故事板` })}
                                                                onContextMenu={(e) => { e.preventDefault(); setMediaMenu({ x: e.clientX, y: e.clientY, idx, kind: "image", uri: shot.storyboardUri! }); }}
                                                                style={{ width: "100%", height: "100%", objectFit: "cover", cursor: "zoom-in" }} />
                                                        ) : isRunning(`sb-${shot.id}`) ? (
                                                            <span style={{ color: "var(--muted-foreground)", fontSize: 12 }}>生成中…</span>
                                                        ) : lastError(`sb-${shot.id}`) ? (
                                                            <span style={{ color: "#f87171", fontSize: 11, padding: 10, textAlign: "center", lineHeight: 1.5 }}>生成失败：{lastError(`sb-${shot.id}`)}</span>
                                                        ) : (
                                                            <span style={{ color: "var(--muted-foreground)", fontSize: 12 }}>待生成</span>
                                                        )}
                                                    </div>
                                                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                                        <div style={{ flex: 1, minWidth: 0, display: "flex", gap: 4, overflowX: "auto", minHeight: 34 }} title="历史记录（点击设为主图）">
                                                            {sbHist.length === 0 && sbDerivedL.length === 0 && jobList(`sb-${shot.id}`).length === 0 ? <span style={{ fontSize: 10, color: "var(--muted-foreground)", alignSelf: "center" }}>暂无历史</span>
                                                                : <>
                                                                    {sbHist.map((u, i) => (
                                                                        <img key={i} src={u} alt="" title="点击设为主图" onClick={() => update(shot.id, { storyboardUri: u })}
                                                                            style={{ width: 32, height: 32, flexShrink: 0, borderRadius: 4, objectFit: "cover", cursor: "pointer", border: u === shot.storyboardUri ? "2px solid #8b5cf6" : "1px solid rgba(255,255,255,0.12)" }} />
                                                                    ))}
                                                                    {sbDerivedL.map((d) => d.status === "running" ? (
                                                                        <span key={d.id} title="图像超分处理中…右击菜单"
                                                                            onContextMenu={(e) => { e.preventDefault(); setDerivedMenu({ x: e.clientX, y: e.clientY, shotId: shot.id, recId: d.id, field: "storyboard" }); }}
                                                                            style={{ width: 32, height: 32, flexShrink: 0, borderRadius: 4, border: "1px dashed rgba(103,232,249,0.6)", display: "flex", alignItems: "center", justifyContent: "center", color: "#67e8f9", fontSize: 12 }}>
                                                                            <span className="sb-spin" style={{ display: "inline-block" }}>↻</span>
                                                                        </span>
                                                                    ) : d.status === "failed" ? (
                                                                        <span key={d.id} title={`图像超分失败：${d.error || "未知错误"}。右击菜单可删除后重试`}
                                                                            onContextMenu={(e) => { e.preventDefault(); setDerivedMenu({ x: e.clientX, y: e.clientY, shotId: shot.id, recId: d.id, field: "storyboard" }); }}
                                                                            style={{ width: 32, height: 32, flexShrink: 0, borderRadius: 4, border: "1px solid rgba(248,113,113,0.7)", display: "flex", alignItems: "center", justifyContent: "center", color: "#f87171", fontSize: 13, cursor: "default" }}>✕</span>
                                                                    ) : (
                                                                        <img key={d.id} src={d.uri} alt="" title="超分记录（点击设为主图，右击菜单：对比原图/删除）"
                                                                            onClick={() => update(shot.id, { storyboardUri: d.uri })}
                                                                            onContextMenu={(e) => { e.preventDefault(); setDerivedMenu({ x: e.clientX, y: e.clientY, shotId: shot.id, recId: d.id, field: "storyboard" }); }}
                                                                            style={{ width: 32, height: 32, flexShrink: 0, borderRadius: 4, objectFit: "cover", cursor: "pointer", border: d.uri === shot.storyboardUri ? "2px solid #8b5cf6" : "1px solid rgba(103,232,249,0.65)" }} />
                                                                    ))}
                                                                    {jobChips(`sb-${shot.id}`)}
                                                                </>}
                                                        </div>
                                                        <button style={{ ...colBtn, width: "auto", whiteSpace: "nowrap" }} onClick={() => genStoryboard(shot)}>生成</button>
                                                    </div>
                                                </div>

                                                {/* 6. 视频区（主视频撑满 + 历史记录 + 生成）*/}
                                                <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 6 }}>
                                                    <div style={{ flex: 1, minHeight: 120, borderRadius: 8, border: "1px solid rgba(255,255,255,0.1)", background: "rgba(0,0,0,0.25)", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
                                                        {shot.videoUri ? (
                                                            <video src={shot.videoUri} controls title="双击放大 / 右键菜单（导出、首尾帧、片段到下一镜）"
                                                                onDoubleClick={() => openLightbox({ uri: shot.videoUri!, media: "video", name: `${shot.title || "分镜"}·视频` })}
                                                                onContextMenu={(e) => { e.preventDefault(); setMediaMenu({ x: e.clientX, y: e.clientY, idx, kind: "video", uri: shot.videoUri! }); }}
                                                                style={{ width: "100%", height: "100%", objectFit: "contain" }} />
                                                        ) : isRunning(`vid-${shot.id}`) ? (
                                                            <span style={{ color: "var(--muted-foreground)", fontSize: 12 }}>生成中…</span>
                                                        ) : lastError(`vid-${shot.id}`) ? (
                                                            <span style={{ color: "#f87171", fontSize: 11, padding: 10, textAlign: "center", lineHeight: 1.5 }}>生成失败：{lastError(`vid-${shot.id}`)}</span>
                                                        ) : (
                                                            <span style={{ color: "var(--muted-foreground)", fontSize: 12 }}>待生成</span>
                                                        )}
                                                    </div>
                                                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                                        <div style={{ flex: 1, minWidth: 0, display: "flex", gap: 4, overflowX: "auto", minHeight: 34 }} title="历史记录（点击设为主视频）">
                                                            {vidHist.length === 0 && vidDerived.length === 0 && jobList(`vid-${shot.id}`).length === 0 ? <span style={{ fontSize: 10, color: "var(--muted-foreground)", alignSelf: "center" }}>暂无历史</span>
                                                                : <>
                                                                    {vidHist.map((u, i) => {
                                                                        const active = ak ? ak === `u:${u}` : u === shot.videoUri;
                                                                        return (
                                                                            <button key={i} title="设为主视频" onClick={() => update(shot.id, { videoUri: u, videoActiveKey: `u:${u}` })}
                                                                                style={{ flexShrink: 0, fontSize: 10, padding: "2px 8px", borderRadius: 4, cursor: "pointer", border: active ? "1px solid #8b5cf6" : "1px solid rgba(255,255,255,0.12)", background: active ? "rgba(139,92,246,0.22)" : "rgba(255,255,255,0.05)", color: "#fff" }}>v{i + 1}</button>
                                                                        );
                                                                    })}
                                                                    {vidDerived.map((d) => {
                                                                        // 无有效选中标识时按 uri 回退，但源记录（vidHist）在场则让位——同 uri 时避免多枚同亮
                                                                        const active = ak ? ak === `d:${d.id}` : !!d.uri && d.uri === shot.videoUri && !vidHist.includes(d.uri);
                                                                        const kindLabel = d.kind === "upscale" ? "超分" : "去字幕";
                                                                        const title = d.status === "running"
                                                                            ? `${kindLabel}处理中（输入 ${d.srcLabel || ""}，火山引擎）…右击菜单`
                                                                            : d.status === "failed"
                                                                                ? `${kindLabel}失败：${d.error || "未知错误"}。右击菜单可删除后重试`
                                                                                : `${kindLabel}记录（输入 ${d.srcLabel || d.label.slice(0, -1)}）· 点击设为主视频，右击菜单：对比原视频/删除`;
                                                                        return (
                                                                            <button key={d.id} title={title}
                                                                                onClick={() => {
                                                                                    if (d.status === "failed") { alert(`${kindLabel}失败：${d.error || "未知错误"}\n右击该记录删除后，可在视频右击菜单重新发起处理。`); return; }
                                                                                    if (d.status === "running" || !d.uri) return;
                                                                                    update(shot.id, { videoUri: d.uri, videoActiveKey: `d:${d.id}` });
                                                                                }}
                                                                                onContextMenu={(e) => {
                                                                                    e.preventDefault();
                                                                                    setDerivedMenu({ x: e.clientX, y: e.clientY, shotId: shot.id, recId: d.id, field: "video" });
                                                                                }}
                                                                                style={{ flexShrink: 0, fontSize: 10, padding: "2px 8px", borderRadius: 4, cursor: d.status ? "default" : "pointer", border: d.status === "failed" ? "1px solid rgba(248,113,113,0.7)" : active ? "1px solid #8b5cf6" : "1px solid rgba(255,255,255,0.12)", background: active ? "rgba(139,92,246,0.22)" : "rgba(255,255,255,0.05)", color: d.status === "failed" ? "#f87171" : d.kind === "upscale" ? "#67e8f9" : "#fdba74" }}>
                                                                                {d.status === "running" ? <span className="sb-spin" style={{ display: "inline-block", marginRight: 3 }}>↻</span> : null}{d.label}
                                                                            </button>
                                                                        );
                                                                    })}
                                                                    {jobChips(`vid-${shot.id}`)}
                                                                </>}
                                                        </div>
                                                        <button style={{ ...colBtn, width: "auto", whiteSpace: "nowrap" }} onClick={() => genVideo(shot)}>生成</button>
                                                    </div>
                                                </div>

                                                {/* 行高拖动手柄（拖下边界 → 统一改所有行高，全局记忆）*/}
                                                <div
                                                    onMouseDown={startRowResize}
                                                    title="拖动调整行高"
                                                    className="qj-row-resize"
                                                    style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 7, cursor: "row-resize", zIndex: 7 }}
                                                />
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    </div>
                </div>

                {/* 故事板图 / 视频 右击菜单 */}
                {mediaMenu && (() => {
                    const lastIdx = (activeEp?.shots.length || 0) - 1;
                    const hasPrev = mediaMenu.idx > 0;
                    const hasNext = mediaMenu.idx < lastIdx;
                    const item = (label: string, onClick: () => void, disabled = false) => (
                        <div onClick={() => { if (!disabled) onClick(); }} title={disabled ? "相邻分镜不存在" : undefined}
                            style={{ padding: "8px 12px", borderRadius: 6, fontSize: 12, cursor: disabled ? "not-allowed" : "pointer", color: disabled ? "rgba(255,255,255,0.35)" : "#fff" }}
                            onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.background = "rgba(139,92,246,0.25)"; }}
                            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>{label}</div>
                    );
                    return (
                        <>
                            <div onClick={() => setMediaMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMediaMenu(null); }} style={{ position: "fixed", inset: 0, zIndex: 60 }} />
                            <div style={{ position: "fixed", zIndex: 61, top: Math.min(mediaMenu.y, window.innerHeight - (mediaMenu.kind === "video" ? 290 : 260)), left: Math.min(mediaMenu.x, window.innerWidth - 200), width: 188, padding: 6, borderRadius: 8, border: "1px solid rgba(255,255,255,0.12)", background: "#161b26", boxShadow: "0 8px 24px rgba(0,0,0,0.5)" }}>
                                {item(mediaMenu.kind === "video" ? "导出视频" : "导出图片", menuExport)}
                                <div style={{ height: 1, background: "rgba(255,255,255,0.08)", margin: "4px 0" }} />
                                {mediaMenu.kind === "image" ? (
                                    <>
                                        {item("添加到上一镜", () => menuAddFrame("first", "prev"), !hasPrev)}
                                        {item("添加到下一镜", () => menuAddFrame("last", "next"), !hasNext)}
                                        <div style={{ height: 1, background: "rgba(255,255,255,0.08)", margin: "4px 0" }} />
                                        {item("图像超分…", () => menuProcess("imageUpscale"))}
                                    </>
                                ) : (
                                    <>
                                        {item("添加首帧到上一镜", () => menuAddFrame("first", "prev"), !hasPrev)}
                                        {item("添加尾帧到下一镜", () => menuAddFrame("last", "next"), !hasNext)}
                                        {item("添加视频片段到下一镜…", menuAddClip, !hasNext)}
                                        <div style={{ height: 1, background: "rgba(255,255,255,0.08)", margin: "4px 0" }} />
                                        {item("超分（画质增强）…", () => menuProcess("upscale"))}
                                        {item("去字幕…", () => menuProcess("desub"))}
                                    </>
                                )}
                            </div>
                        </>
                    );
                })()}

                {/* 原文分段右击菜单：进入/退出编辑模式 */}
                {segMenu && (
                    <>
                        <div onClick={() => setSegMenu(null)} onContextMenu={(e) => { e.preventDefault(); setSegMenu(null); }} style={{ position: "fixed", inset: 0, zIndex: 60 }} />
                        <div style={{ position: "fixed", zIndex: 61, top: Math.min(segMenu.y, window.innerHeight - 90), left: Math.min(segMenu.x, window.innerWidth - 190), width: 176, padding: 6, borderRadius: 8, border: "1px solid rgba(255,255,255,0.12)", background: "#161b26", boxShadow: "0 8px 24px rgba(0,0,0,0.5)" }}>
                            <div onClick={() => { setSegEdit((p) => ({ ...p, [segMenu.shotId]: !p[segMenu.shotId] })); setSegMenu(null); }}
                                style={{ padding: "8px 12px", borderRadius: 6, fontSize: 12, cursor: "pointer", color: "#fff" }}
                                onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(139,92,246,0.25)")}
                                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                                {segEdit[segMenu.shotId] ? "退出编辑模式" : "进入编辑模式"}
                            </div>
                        </div>
                    </>
                )}

                {clipModal && (
                    <ClipPickerModal
                        uri={clipModal.uri}
                        title="选择视频片段（添加到下一镜）"
                        confirmText="提取并添加到下一镜"
                        hint="由内置 ffmpeg 裁剪为 mp4（无需等待播放）；浏览器环境下回退为实时录制 webm。"
                        onCancel={() => setClipModal(null)}
                        onConfirm={(s, e) => doAddClip(s, e)}
                    />
                )}

                {procModal && (
                    <VideoProcessModal
                        uri={procModal.uri}
                        mode={procModal.mode}
                        sourceName={activeEp?.shots[procModal.idx]?.title || `分镜${procModal.idx + 1}`}
                        onCancel={() => setProcModal(null)}
                        onConfirm={doProcessVideo}
                    />
                )}

                {/* 派生记录右击菜单（视频 v1+/v1- 与故事板超分记录共用）：对比原素材 / 设为主图主视频 / 删除 */}
                {derivedMenu && (() => {
                    const sh = activeEp?.shots.find((s) => s.id === derivedMenu.shotId);
                    const list = derivedMenu.field === "storyboard" ? sh?.sbDerived : sh?.videoDerived;
                    const rec = list?.find((d) => d.id === derivedMenu.recId);
                    if (!sh || !rec) return null;
                    const media = derivedMenu.field === "storyboard" ? ("image" as const) : ("video" as const);
                    const kindLabel = rec.kind === "upscale" ? "超分" : "去字幕";
                    const dispUri = (u: string) => useProjectStore.getState().blobByUri(u)?.localUri || u;
                    const closeM = () => setDerivedMenu(null);
                    const item = (label: string, onClick: () => void, disabled = false, danger = false) => (
                        <div onClick={() => { if (!disabled) { closeM(); onClick(); } }}
                            style={{ padding: "8px 12px", borderRadius: 6, fontSize: 12, cursor: disabled ? "not-allowed" : "pointer", color: disabled ? "rgba(255,255,255,0.35)" : danger ? "#f8c8c8" : "#fff" }}
                            onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.background = "rgba(139,92,246,0.25)"; }}
                            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>{label}</div>
                    );
                    return (
                        <>
                            <div onClick={closeM} onContextMenu={(e) => { e.preventDefault(); closeM(); }} style={{ position: "fixed", inset: 0, zIndex: 60 }} />
                            <div style={{ position: "fixed", zIndex: 61, top: Math.min(derivedMenu.y, window.innerHeight - 160), left: Math.min(derivedMenu.x, window.innerWidth - 200), width: 188, padding: 6, borderRadius: 8, border: "1px solid rgba(255,255,255,0.12)", background: "#161b26", boxShadow: "0 8px 24px rgba(0,0,0,0.5)" }}>
                                {item(media === "image" ? "对比原图" : "对比原视频", () => {
                                    setCompareData({
                                        media,
                                        beforeUri: dispUri(rec.srcUri),
                                        afterUri: dispUri(rec.uri),
                                        afterLabel: kindLabel,
                                        title: `${kindLabel}对比 · ${sh.title || "分镜"}${derivedMenu.field === "video" ? ` ${rec.label}` : ""}`,
                                    });
                                }, !rec.uri || !rec.srcUri || !!rec.status)}
                                {item(media === "image" ? "设为主图" : "设为主视频", () => {
                                    if (media === "image") update(sh.id, { storyboardUri: rec.uri });
                                    else update(sh.id, { videoUri: rec.uri, videoActiveKey: `d:${rec.id}` });
                                }, !rec.uri || !!rec.status)}
                                <div style={{ height: 1, background: "rgba(255,255,255,0.08)", margin: "4px 0" }} />
                                {item(`删除记录${rec.status === "running" ? "（丢弃处理）" : ""}`, () => {
                                    if (derivedMenu.field === "storyboard") {
                                        update(sh.id, { sbDerived: (sh.sbDerived || []).filter((x) => x.id !== rec.id) });
                                    } else {
                                        update(sh.id, {
                                            videoDerived: (sh.videoDerived || []).filter((x) => x.id !== rec.id),
                                            ...(sh.videoActiveKey === `d:${rec.id}` ? { videoActiveKey: undefined } : {}),
                                        });
                                    }
                                }, false, true)}
                            </div>
                        </>
                    );
                })()}

                {/* 全屏对比弹窗（对比原图/原视频） */}
                {compareData && (
                    <MediaCompareModal
                        media={compareData.media}
                        beforeUri={compareData.beforeUri}
                        afterUri={compareData.afterUri}
                        beforeLabel={compareData.media === "image" ? "原图" : "原视频"}
                        afterLabel={compareData.afterLabel}
                        title={compareData.title}
                        onClose={() => setCompareData(null)}
                    />
                )}

                {mediaBusy && (
                    <div style={{ position: "fixed", inset: 0, zIndex: 80, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.45)" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 22px", borderRadius: 10, background: "#161b26", border: "1px solid rgba(255,255,255,0.12)", color: "#fff", fontSize: 13 }}>
                            <span className="sb-spin" style={{ display: "inline-block" }}>↻</span>{mediaBusy}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export default Frame161195;
