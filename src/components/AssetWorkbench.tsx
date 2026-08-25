import { useState, useEffect, useMemo, useRef } from "react";
import { useNavigate } from "react-router";
import { useProjectStore, type AssetCat } from "@/store/projectStore";
import { startGeneration, retryGeneration, recallPendingGeneration } from "@/services/generationQueue";
import ModelPicker, { effectiveModelKey, useEffectiveModelKey } from "@/components/ModelPicker";
import { useCatalogStore } from "@/store/catalogStore";
import type { Purpose } from "@/contract";
import type { UiSnapshot } from "@/services/projectFile";
import { useScrollSnapshot } from "@/hooks/useScrollSnapshot";
import { openLightbox } from "@/store/lightboxStore";
import { PromptExpandButton } from "@/components/PromptExpandButton";
import { managedClient } from "@/services/managedClient";
import { saveRemoteAsset, saveUploadedLocal } from "@/services/assetPersist";
import { runAssetCheck, assetEntityTargets } from "@/services/assetCheck";
import { sharedItemFromUri } from "@/services/sharedPublish";
import { openSharedPick } from "@/store/sharedPickStore";
import { confirmDialog } from "@/lib/confirmDialog";
import { listPresetOptions } from "@/lib/presetSchemes";

interface AssetWorkbenchProps {
    cat: AssetCat;                 // 角色/场景/生物/物品/群像 对应的 store 数组字段
    unit: string;                  // 单位名，如「角色」「场景」
    imagePurpose: Purpose;         // 出图 purpose，如 asset.character.image
    textField: "features" | "description"; // 角色/群像=features，其余=description
    showVoice?: boolean;           // 是否显示音色选择（角色/群像）
}

type Form = {
    key: string;                   // "base" 或 变体 id
    variantId: string | null;     // null=基础形象
    label: string;                 // 徽标
    title: string;                 // 标题（名称）
    desc: string;                  // 副标题/说明
    prompt: string;
    image?: string;
    images: string[];
};

// 出图要求常量（模型/质量/比例/分辨率）抽到 @/lib/genParams，画布「生成图片」节点共用、保持一致。
import { IMAGE_QUALITIES as QUALITIES, IMAGE_ASPECTS as ASPECTS, imageResolutionOptions, clampImageResolution, resolveSize } from "@/lib/genParams";
import { assetImageAspectFrom } from "@/lib/templateAspect";
import { mediaFilesFromClipboard } from "@/lib/clipboardMedia";

// 资产 id 类型前缀（管理端据此分配 C00000123 等）：角色 C / 群像 G / 场景 S / 生物 M / 物品 P
const CAT_PREFIX: Record<AssetCat, string> = { characters: "C", crowds: "G", scenes: "S", organisms: "M", items: "P" };
// 分组中文名 + 各组文本字段（角色/群像=features，其余=description）——更改分组时映射文本字段用
const CAT_LABEL: Record<AssetCat, string> = { characters: "角色", crowds: "群像", scenes: "场景", organisms: "生物", items: "物品" };
const CAT_TEXTFIELD: Record<AssetCat, "features" | "description"> = { characters: "features", crowds: "features", scenes: "description", organisms: "description", items: "description" };
const ALL_CATS: AssetCat[] = ["characters", "crowds", "scenes", "organisms", "items"];

function isTauri(): boolean {
    return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

const panel: React.CSSProperties = { background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8 };
const accent = "#8b5cf6";

const AssetWorkbench = ({ cat, unit, imagePurpose, textField, showVoice }: AssetWorkbenchProps) => {
    const navigate = useNavigate();
    const assets = useProjectStore((s) => s[cat]) as any[];
    const {
        addAsset, removeAsset, updateAsset, addAssetVariant, updateAssetVariant, removeAssetVariant, setAssetMainImage, addAssetImage, removePendingGen,
    } = useProjectStore.getState();
    const [manageMode, setManageMode] = useState(false); // 管理模式：资产列表每项显示删除
    const [manageFormsMode, setManageFormsMode] = useState(false); // 管理模式：造型/分体每项显示删除（基础形象除外）

    // 界面快照：本资产页（按 cat 分键）上次的选中/搜索/列表滚动；挂载时取一次作为初值
    const snap0 = useProjectStore.getState().uiSnapshot?.assetPages?.[cat];
    const [selectedId, setSelectedId] = useState<string | null>(snap0?.selectedId ?? null);
    const [selectedFormKey, setSelectedFormKey] = useState<string>(snap0?.selectedFormKey ?? "base");
    const [searchQuery, setSearchQuery] = useState(snap0?.searchQuery ?? "");
    // 资产列表滚动位置快照
    const listScroll = useScrollSnapshot(
        snap0?.listScrollTop,
        (top) => useProjectStore.getState().setUiSnapshot({ assetPages: { [cat]: { listScrollTop: top } } as UiSnapshot["assetPages"] }),
        [assets.length],
    );
    const [quality, setQuality] = useState("high");
    // 第243轮比例决定链：资产拆分模板名内嵌比例（如「资产拆分9:16」）> 项目默认影片比例（mediaSettings.imageAspect）> 16:9；
    // 页内改动（会话态）仍最高优先。挂载时解析一次（catalog 极端未到货时退项目默认，重进页面即取到）。
    const [aspect, setAspect] = useState(() => assetImageAspectFrom(
        useCatalogStore.getState().catalog?.templates,
        useProjectStore.getState().mediaSettings?.assetExtractTplId,
        useProjectStore.getState().mediaSettings?.imageAspect,
    ));
    const [resolutionRaw, setResolution] = useState("2k");
    // 分辨率档由服务端按当前生效图像模型下发（catalog params.resolution 枚举），选择不在开放集时归一到第一档
    const imgModelKey = useEffectiveModelKey("image");
    const catalogModelsForRes = useCatalogStore((s) => s.catalog?.models);
    const resOptions = useMemo(
        () => imageResolutionOptions(catalogModelsForRes?.find((m) => m.id === imgModelKey)),
        [catalogModelsForRes, imgModelKey],
    );
    const resolution = clampImageResolution(resolutionRaw, resOptions);
    // 区5 图片：自然分辨率信息 + 框内缩放/平移
    const [imgDims, setImgDims] = useState<{ w: number; h: number } | null>(null);
    const [imgScale, setImgScale] = useState(1);
    const [imgOffset, setImgOffset] = useState({ x: 0, y: 0 });
    const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
    const pendingGens = useProjectStore((s) => s.pendingGens);
    const genMetaMap = useProjectStore((s) => s.genMeta);
    // 展示区当前查看的历史项：成功图 / 在途任务（运行中或失败）；null=看主图
    const [viewSel, setViewSel] = useState<{ kind: "image"; uri: string } | { kind: "pending"; id: string } | null>(null);
    const [detailOpen, setDetailOpen] = useState(false); // 「详情」面板：看当前图请求时的提示词+垫图
    const [uploadingImg, setUploadingImg] = useState(false); // 展示区「上传本地图片作为资产」中
    const [uploadingVoice, setUploadingVoice] = useState(false); // 绑定音色「本地上传」中
    // 垫图（图生图参考素材）：uri=可渲染预览（本地/公网均可），url=请求用公网 url（服务端 fetch 做图生图）。
    // 区分二者后：变体默认垫图用基础形象的本地可渲染 uri 作预览（不再无预览图），请求用其公网 url。
    type RefImg = { id: string; uri: string; url?: string; name?: string; uploading?: boolean; error?: boolean };
    const [refImages, setRefImages] = useState<RefImg[]>([]);
    const refImagesRef = useRef<RefImg[]>([]); // 最新 refImages 镜像，供 mutateRefs 在 updater 外安全计算
    const [refPickerOpen, setRefPickerOpen] = useState(false);
    const refUid = () => `ref-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    // 垫图记忆：当前 资产+造型 的 key；用户增删垫图即持久化（切走再回来不丢，区别于纯默认 seed）
    const refMemKey = () => (selectedId ? `${cat}:${selectedId}:${selectedFormKey}` : null);
    const persistRefs = (refs: RefImg[]) => {
        const key = refMemKey();
        if (!key) return;
        const clean = refs.filter((r) => !r.uploading && !r.error).map(({ id, uri, url, name }) => ({ id, uri, url, name }));
        useProjectStore.getState().setAssetRefImages(key, clean);
    };
    // 包裹 setRefImages：基于最新值镜像算出 next（不在 state updater 里产生副作用），同步状态 + 落盘记忆。
    // 默认 seed 不走它，保持动态（随基础图变化）。
    const mutateRefs = (updater: (prev: RefImg[]) => RefImg[]) => {
        const next = updater(refImagesRef.current);
        refImagesRef.current = next;
        setRefImages(next);
        persistRefs(next);
    };
    // 镜像同步：默认 seed 走 setRefImages（不经 mutateRefs），这里把最新值同步到 ref
    useEffect(() => { refImagesRef.current = refImages; }, [refImages]);
    // 重命名（资产列表 / 分体列表）+ 资产右键菜单（导出 / 改组 / 替换基础形象 / 本地上传）
    const [renaming, setRenaming] = useState<{ kind: "asset" | "form"; id: string; variantId: string | null } | null>(null);
    const [renameVal, setRenameVal] = useState("");
    const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; asset: any } | null>(null);
    const [ctxSub, setCtxSub] = useState<"group" | "replace" | null>(null);
    // 造型卡右键管理菜单（重命名 / 添加到共享资产 / 删除；基础形象不可删）
    const [formCtx, setFormCtx] = useState<{ x: number; y: number; variantId: string | null; label: string; title: string; image?: string; shareName: string } | null>(null);

    // 资产库可选垫图（跨类：角色/群像/场景/生物/物品的主图）
    const allCats = useProjectStore((s) => ({ characters: s.characters, crowds: s.crowds, scenes: s.scenes, organisms: s.organisms, items: s.items }));
    const libraryImages = useMemo(() => {
        const out: Array<{ uri: string; name: string }> = [];
        for (const arr of Object.values(allCats)) {
            for (const a of arr as any[]) if (a.image) out.push({ uri: a.image, name: a.name });
        }
        return out;
    }, [allCats]);

    // 本地上传垫图：先以 dataURL 占位预览，再上传到 OSS（managedClient.uploadAsset）拿公网 url 供服务端 fetch。
    // 严格：上传失败标红（不静默用 dataURL，否则服务端 fetch 不到、图生图无效）。
    const addLocalRef = (file: File) => {
        const id = refUid();
        const reader = new FileReader();
        reader.onload = () => mutateRefs((prev) => [...prev, { id, uri: String(reader.result), name: file.name, uploading: true }]);
        reader.readAsDataURL(file);
        void (async () => {
            try {
                const res = await managedClient.uploadAsset(file, file.name, "TP");
                // 与生成资产同策略：落一份本地原件，显示改走 asset:// 本地 uri，绝不把 base64 dataURL 落进项目文件
                // （genMeta/assetRefImages 存 base64 是项目文件膨胀→保存中断损坏的根源）。字节直取自 File，无需二次下载。
                const blob = await saveUploadedLocal(file, res.id, res.url, file.name);
                if (!blob) useProjectStore.getState().registerAssetBlob({ id: res.id, url: res.url }); // 非 Tauri 兜底
                // Tauri：uri 换成本地 localUri（丢弃 base64 预览）；浏览器（无本地副本）：保留 base64 预览。url 恒为公网 OSS 供服务端 fetch。
                mutateRefs((prev) => prev.map((r) => r.id === id
                    ? { ...r, url: res.url, uploading: false, ...(blob?.localUri ? { uri: blob.localUri } : {}) }
                    : r));
            } catch (e) {
                console.warn("[asset] 垫图上传失败：", e);
                mutateRefs((prev) => prev.map((r) => r.id === id ? { ...r, uploading: false, error: true } : r));
            }
        })();
    };

    // 垫图引用需服务端可 fetch：本地 uri(asset://) 解析回公网 url（图生图底图）
    const toRefUri = (displayUri: string) => useProjectStore.getState().blobByUri(displayUri)?.url || displayUri;

    // 拖放到垫图素材区：资产助手卡片 / 本地图片文件 → 垫图
    const onRefDrop = (e: React.DragEvent) => {
        e.preventDefault();
        const raw = e.dataTransfer.getData("application/x-qiji-asset") || e.dataTransfer.getData("text/plain");
        if (raw) {
            try {
                const d = JSON.parse(raw);
                // 预览用可渲染 uri（本地优先），请求用公网 url
                const preview = d?.localUri || d?.uri || d?.url;
                const pub = d?.url || toRefUri(preview);
                if (preview) { mutateRefs((prev) => prev.some((r) => r.uri === preview) ? prev : [...prev, { id: refUid(), uri: preview, url: pub, name: d.name }]); return; }
            } catch { /* 非 JSON，落到文件分支 */ }
        }
        const f = e.dataTransfer.files?.[0];
        if (f && f.type.startsWith("image/")) {
            // 原生拖入的资产文件名为 <assetId>.<ext> → 解析回三元映射，预览用本地、请求用公网
            const base = f.name.replace(/\.[^.]+$/, "");
            const blob = useProjectStore.getState().assetBlobs[base];
            const preview = blob?.localUri || blob?.url;
            if (preview) mutateRefs((prev) => prev.some((r) => r.uri === preview) ? prev : [...prev, { id: refUid(), uri: preview, url: blob?.url, name: f.name }]);
            else addLocalRef(f);
        }
    };

    useEffect(() => {
        if (assets.length > 0 && !assets.find((a) => a.id === selectedId)) {
            setSelectedId(assets[0].id);
            setSelectedFormKey("base");
        }
    }, [assets, selectedId]);

    // 选中资产 / 造型 / 搜索词变更 → 写入界面快照（跳过首帧初值回写）
    const firstUiRef = useRef(true);
    useEffect(() => {
        if (firstUiRef.current) { firstUiRef.current = false; return; }
        useProjectStore.getState().setUiSnapshot({
            assetPages: { [cat]: { selectedId: selectedId ?? undefined, selectedFormKey, searchQuery } } as UiSnapshot["assetPages"],
        });
    }, [cat, selectedId, selectedFormKey, searchQuery]);

    const activeAsset = assets.find((a) => a.id === selectedId) || null;

    // 当前资产的「分体/造型」列表：基础形象为第 1 个，其后为变体
    const forms: Form[] = useMemo(() => {
        if (!activeAsset) return [];
        const base: Form = {
            key: "base", variantId: null, label: "基础形象", title: activeAsset.name,
            desc: activeAsset[textField] || "", prompt: activeAsset.prompt || "",
            image: activeAsset.image, images: activeAsset.images || [],
        };
        const variants: Form[] = (activeAsset.variants || []).map((v: any) => ({
            key: v.id, variantId: v.id, label: v.label || "造型", title: v.name || activeAsset.name,
            desc: v.description || "", prompt: v.prompt || "", image: v.image, images: v.images || [],
        }));
        return [base, ...variants];
    }, [activeAsset, textField]);

    const activeForm = forms.find((f) => f.key === selectedFormKey) || forms[0] || null;

    // 切换显示图片/查看项时复位框内缩放/平移
    useEffect(() => { setImgScale(1); setImgOffset({ x: 0, y: 0 }); }, [activeForm?.image, viewSel]);

    // 切换资产/造型：复位展示区查看项与详情面板
    useEffect(() => { setViewSel(null); setDetailOpen(false); }, [selectedId, selectedFormKey]);

    // 选择造型时初始化垫图：① 有记忆（用户上次增删过）→ 还原记忆，切走再回来不丢；
    // ② 无记忆 + 分体（变体）→ 默认参考基础形象（动态，随基础图变化）；③ 否则空。
    useEffect(() => {
        const key = selectedId ? `${cat}:${selectedId}:${selectedFormKey}` : null;
        const saved = key ? useProjectStore.getState().assetRefImages?.[key] : undefined;
        if (saved) {
            // 记忆存在（含「用户清空成空数组」）→ 直接还原，尊重用户选择
            setRefImages(saved.map((r) => ({ ...r, id: r.id || refUid() })));
        } else if (activeForm?.variantId && activeAsset?.image) {
            // 预览用基础形象的本地可渲染 uri（不再无预览图），请求用其公网 url
            setRefImages([{ id: refUid(), uri: activeAsset.image, url: toRefUri(activeAsset.image), name: `${activeAsset.name}·基础形象` }]);
        } else {
            setRefImages([]);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedId, selectedFormKey]);

    const filtered = assets.filter((a) =>
        a.name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (a[textField] || "").toLowerCase().includes(searchQuery.toLowerCase())
    );

    const writePrompt = (form: Form, prompt: string) => {
        if (form.variantId) updateAssetVariant(cat, activeAsset.id, form.variantId, { prompt });
        else updateAsset(cat, activeAsset.id, { prompt });
    };

    // 在途任务（断连保护）：按 资产+造型 过滤；运行中=占位、失败=标红可重试
    const pendingFor = (assetId: string, variantId: string | null) =>
        pendingGens.filter((p) => p.cat === cat && p.assetId === assetId && p.variantId === variantId);
    const isRunning = (assetId: string, variantId: string | null) =>
        pendingFor(assetId, variantId).some((p) => p.status === "running");
    // 该造型是否处于失败态（无运行中、且有失败）→ 造型卡显示错误图标
    const isFailed = (assetId: string, variantId: string | null) => {
        const ps = pendingFor(assetId, variantId);
        return !ps.some((p) => p.status === "running") && ps.some((p) => p.status === "failed");
    };
    // 资产级（跨所有造型/变体）在途汇总：左侧资产头像据此显示「生成中 / 失败」角标
    const assetRunning = (assetId: string) =>
        pendingGens.some((p) => p.cat === cat && p.assetId === assetId && p.status === "running");
    const assetFailed = (assetId: string) =>
        !assetRunning(assetId) && pendingGens.some((p) => p.cat === cat && p.assetId === assetId && p.status === "failed");

    // 生成一张：交给 generationQueue 持久化在途任务（切页/关软件不丢；UI 由 pendingGens 驱动）
    const generateForm = (assetId: string, form: Form) => {
        if (!form.prompt.trim()) { alert("该造型暂无提示词，请先填写出图提示词。"); return; }
        const modelKey = effectiveModelKey("image");
        const size = resolveSize(aspect, resolution);
        // 有垫图 → 图生图：把参考图作为 input.images 传入（跳过上传中/失败的）。
        // 优先带上资产 id（服务端按 id 直接取字节/OSS直链，最稳，"id 是真理"），url 作双保险。
        const usable = refImages.filter((r) => !r.uploading && !r.error);
        const toInputRef = (r: RefImg) => {
            const blob = useProjectStore.getState().blobByUri(r.uri) || useProjectStore.getState().blobByUri(r.url || "");
            const url = r.url || toRefUri(r.uri);
            return blob?.id ? { id: blob.id, url } : { url };
        };
        const input = usable.length ? { images: usable.map(toInputRef) } : undefined;
        // 垫图详情（可渲染预览 uri + 名称 + 资产 id）：供「详情」回看本次用了哪些垫图
        const refs = usable.map((r) => {
            const blob = useProjectStore.getState().blobByUri(r.uri) || useProjectStore.getState().blobByUri(r.url || "");
            return { name: r.name, uri: r.uri, id: blob?.id };
        });
        startGeneration({ cat, assetId, variantId: form.variantId, purpose: imagePurpose, prompt: form.prompt, modelKey, input, refs, params: { size, quality, idPrefix: CAT_PREFIX[cat], assetName: form.title }, label: form.title });
    };

    // 区域2 一键生成：仅为「未生成（无基础形象图）」和「失败」的资产生成基础形象；
    // 已生成且非失败的、正在生成中的、无提示词的，一律跳过（避免重复消耗额度）。
    const generateAllBase = () => {
        const modelKey = effectiveModelKey("image");
        const size = resolveSize(aspect, resolution);
        let n = 0, skipped = 0;
        for (const a of assets) {
            if (!a.prompt?.trim()) { skipped++; continue; }        // 无提示词不能生成
            if (isRunning(a.id, null)) { skipped++; continue; }     // 已在生成中
            if (a.image && !isFailed(a.id, null)) { skipped++; continue; } // 已生成且未失败
            startGeneration({ cat, assetId: a.id, variantId: null, purpose: imagePurpose, prompt: a.prompt, modelKey, params: { size, quality, idPrefix: CAT_PREFIX[cat], assetName: a.name }, label: a.name });
            n++;
        }
        alert(n > 0
            ? `已提交 ${n} 个${unit}的基础形象生成（仅未生成/失败的${skipped ? `，跳过 ${skipped} 个` : ""}）。`
            : `没有需要生成的${unit}：未生成或失败的都已在处理，或缺少提示词。`);
    };

    // 区域2 新建：在当前类别追加一个空白资产并选中（文本字段按类别 features/description）
    const newAsset = () => {
        const id = `${cat}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        const a: Record<string, any> = { id, name: `新${unit}`, philosophy: "", prompt: "", image: undefined, images: [], variants: [] };
        a[textField] = "";
        addAsset(cat, a);
        setSelectedId(id);
        setSelectedFormKey("base");
        setSearchQuery("");      // 清搜索，确保新项可见
        setManageMode(false);
    };

    // 区域2 删除：从当前类别移除资产（连带清残留在途记录）；删中的是选中项则交由 effect 回选首项
    const deleteAsset = async (id: string, name: string) => {
        if (!(await confirmDialog(`删除${unit}「${name}」？将一并移除其所有造型与历史图，操作不可撤销。`))) return;
        removeAsset(cat, id);
        void useProjectStore.getState().save(true);
    };

    // ── #10 重命名（资产 / 分体）──
    const startRename = (kind: "asset" | "form", id: string, variantId: string | null, curName: string) => {
        setRenaming({ kind, id, variantId });
        setRenameVal(curName);
    };
    const commitRename = () => {
        if (!renaming) { return; }
        const name = renameVal.trim();
        if (name) {
            if (renaming.variantId) updateAssetVariant(cat, renaming.id, renaming.variantId, { name });
            else updateAsset(cat, renaming.id, { name });
            void useProjectStore.getState().save(true);
        }
        setRenaming(null);
    };

    // ── #11 右键菜单动作 ──
    const closeCtx = () => { setCtxMenu(null); setCtxSub(null); };
    // 更改分组：从当前类别移到目标类别（保留名称/提示词/图/分体，映射文本字段 features↔description）
    const moveAssetToCat = (asset: any, target: AssetCat) => {
        if (target === cat) { closeCtx(); return; }
        const srcText = asset[textField] || "";
        const newAsset = { ...asset, [CAT_TEXTFIELD[target]]: srcText };
        removeAsset(cat, asset.id);
        addAsset(target, newAsset);
        void useProjectStore.getState().save(true);
        closeCtx();
        alert(`已将「${asset.name}」移动到「${CAT_LABEL[target]}」分组。`);
    };
    // 用某个分体的图替换基础形象（写入基础形象历史并设为主图）
    const replaceBaseFromVariant = (asset: any, image: string) => {
        addAssetImage(cat, asset.id, null, image, true);
        void useProjectStore.getState().save(true);
        closeCtx();
    };
    // 上传一个本地文件到 OSS 成正式资产：返回 {assetId, displayUri(本地优先/公网兜底)}；并注册完整三元映射。
    // 与「生成资产」同链路（uploadAsset→OSS→saveRemoteAsset 下载本地副本+映射），失败抛出由调用方提示。
    const uploadAsAsset = async (file: File): Promise<{ assetId: string; displayUri: string }> => {
        const res = await managedClient.uploadAsset(file, file.name, CAT_PREFIX[cat]); // 服务端落 OSS（配置 OSS 时为公网直链）+ 分配资产 id
        let displayUri = res.url;
        const blob = await saveRemoteAsset(res.id, res.url); // 下载本地副本 + 注册到服务端
        if (blob) { useProjectStore.getState().registerAssetBlob(blob); displayUri = blob.localUri || res.url; }
        else useProjectStore.getState().registerAssetBlob({ id: res.id, url: res.url });
        return { assetId: res.id, displayUri };
    };

    // ── 绑定音色：本地上传音频 → OSS（audio 前缀资产）→ 绑定到当前角色 ──
    // 与生成资产同链路（uploadAsset→OSS→saveRemoteAsset 本地副本+三元映射），音频前缀走 "audio" 桶（不占角色 C 命名空间）。
    const handleVoiceUpload = async (file: File) => {
        if (!activeAsset) return;
        setUploadingVoice(true);
        try {
            const res = await managedClient.uploadAsset(file, file.name, "audio"); // 服务端落 OSS + 分配 audio 前缀资产 id
            let displayUri = res.url;
            const blob = await saveRemoteAsset(res.id, res.url);
            if (blob) { useProjectStore.getState().registerAssetBlob(blob); displayUri = blob.localUri || res.url; }
            else useProjectStore.getState().registerAssetBlob({ id: res.id, url: res.url });
            updateAsset(cat, activeAsset.id, { voiceUri: displayUri, voiceAssetId: res.id, voiceName: `${activeAsset.name}的声音` });
            void useProjectStore.getState().save(true);
        } catch (e) {
            alert(`音频上传失败：${e instanceof Error ? e.message : "未知错误"}`);
        } finally {
            setUploadingVoice(false);
        }
    };
    const removeVoice = () => {
        if (!activeAsset) return;
        updateAsset(cat, activeAsset.id, { voiceUri: undefined, voiceAssetId: undefined, voiceName: undefined });
        void useProjectStore.getState().save(true);
    };

    // 本地上传为新资产：必须走 OSS（拿资产 id + 公网 url）；失败大声报错，绝不静默留 dataURL
    const uploadLocalAsset = async (file: File) => {
        closeCtx();
        setUploadingImg(true);
        try {
            const { displayUri } = await uploadAsAsset(file);
            const id = `${cat}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
            const a: Record<string, any> = { id, name: file.name.replace(/\.[^.]+$/, ""), philosophy: "", prompt: "", image: displayUri, images: [displayUri], variants: [] };
            a[textField] = "";
            addAsset(cat, a);
            setSelectedId(id); setSelectedFormKey("base"); setSearchQuery("");
            await useProjectStore.getState().save(true);
        } catch (e) {
            alert(`本地上传资产失败（未做 OSS 存储）：${e instanceof Error ? e.message : "未知错误"}`);
        } finally {
            setUploadingImg(false);
        }
    };
    // 把一张图片保存到磁盘（Tauri 走另存对话框 / 浏览器走下载），默认名 baseName
    const saveImageFile = async (uri: string, baseName: string) => {
        const safe = (baseName || "资产").replace(/[\\/:*?"<>|]/g, "_");
        const blob = useProjectStore.getState().blobByUri(uri);
        const ext = (blob?.ext || (uri.match(/\.(png|jpe?g|webp|gif)(?:\?|$)/i)?.[1] || "png")).toLowerCase();
        if (isTauri()) {
            try {
                const { save } = await import("@tauri-apps/plugin-dialog");
                const dest = await save({ defaultPath: `${safe}.${ext}`, filters: [{ name: "图片", extensions: [ext, "png", "jpg", "webp"] }] }) as string | null;
                if (!dest) return;
                const fs = await import("@tauri-apps/plugin-fs");
                if (blob?.localPath) await fs.copyFile(blob.localPath, dest);
                else { const resp = await fetch(blob?.url || uri); await fs.writeFile(dest, new Uint8Array(await resp.arrayBuffer())); }
                alert(`已保存：${dest}`);
            } catch (e) { alert(`保存失败：${e instanceof Error ? e.message : "未知错误"}`); }
        } else {
            const a = document.createElement("a"); a.href = blob?.url || uri; a.download = `${safe}.${ext}`; a.click();
        }
    };
    // ── #8 导出资产图片（默认名=资产名）──
    const exportAsset = async (asset: any) => {
        closeCtx();
        if (!asset.image) { alert("该资产还没有图片可导出。"); return; }
        await saveImageFile(asset.image, asset.name);
    };

    // ── 展示区：上传本地图片作为当前造型的资产形象（必走 OSS：拿资产 id + 公网 url → 本地副本入历史并设主图）──
    const uploadImageToForm = async (file: File) => {
        if (!activeAsset || !activeForm) return;
        setUploadingImg(true);
        try {
            const { displayUri } = await uploadAsAsset(file);
            addAssetImage(cat, activeAsset.id, activeForm.variantId, displayUri, true);
            await useProjectStore.getState().save(true);
        } catch (e) {
            alert(`上传失败（未做 OSS 存储）：${e instanceof Error ? e.message : "未知错误"}`);
        } finally {
            setUploadingImg(false);
        }
    };
    // ── 展示区：保存当前资产图片（默认名=资产名 + 第几次历史记录编号）──
    const saveCurrentImage = async () => {
        if (!activeForm?.image) { alert("当前没有可保存的图片。"); return; }
        const hist = activeForm.images.filter(Boolean);
        const idx = hist.indexOf(activeForm.image);
        const histNo = idx >= 0 ? idx + 1 : (hist.length || 1);
        await saveImageFile(activeForm.image, `${activeForm.title}-${histNo}`);
    };

    // 区域3 一键生成：仅为「未生成（无图）」和「失败」的造型（基础+变体）生成；
    // 已生成且未失败的、正在生成中的、无提示词的跳过。
    const generateAllForms = () => {
        if (!activeAsset) return;
        let n = 0, skipped = 0;
        for (const f of forms) {
            if (!f.prompt.trim()) { skipped++; continue; }
            if (isRunning(activeAsset.id, f.variantId)) { skipped++; continue; }
            if (f.image && !isFailed(activeAsset.id, f.variantId)) { skipped++; continue; }
            generateForm(activeAsset.id, f);
            n++;
        }
        alert(n > 0
            ? `已提交 ${n} 个造型生成（仅未生成/失败的${skipped ? `，跳过 ${skipped} 个` : ""}）。`
            : "没有需要生成的造型：未生成或失败的都已在处理，或缺少提示词。");
    };

    // 区域3 删除：移除一个分体（变体）。基础形象不可删（随资产存在）；删中的是选中项则回到基础形象
    const deleteVariant = async (variantId: string, label: string) => {
        if (!activeAsset) return;
        if (!(await confirmDialog(`删除造型「${label}」？将一并移除其历史图，操作不可撤销。`))) return;
        removeAssetVariant(cat, activeAsset.id, variantId);
        if (selectedFormKey === variantId) setSelectedFormKey("base");
        void useProjectStore.getState().save(true);
    };

    const addVariant = () => {
        if (!activeAsset) return;
        const vid = `v-${Date.now()}`;
        addAssetVariant(cat, activeAsset.id, {
            id: vid, label: "新造型", name: activeAsset.name, description: "",
            prompt: activeAsset.prompt || "", image: undefined, images: [],
        });
        setSelectedFormKey(vid);
    };

    // 当前造型的在途生成（每条独立=一个历史占位）；展示区按「查看项」viewSel 决定显示，互不叠加
    const activePendings = activeAsset && activeForm ? pendingFor(activeAsset.id, activeForm.variantId) : [];
    // 查看中的在途任务（viewSel 指向 pending 且仍存在；完成/移除后回退）
    const viewPending = viewSel?.kind === "pending" ? activePendings.find((p) => p.id === viewSel.id) : undefined;
    // viewSel 指定的成功图 → 用它；否则回退主图（仅当不在看某个 pending 时）
    const viewImageUri = viewPending ? undefined : ((viewSel?.kind === "image" ? viewSel.uri : undefined) ?? activeForm?.image);
    // 无主图、无明确查看项时：有运行中在途则兜底「生成中」（失败不兜底，须点选才显示——不干扰）
    const fallbackRunning = (!viewPending && !viewImageUri) ? activePendings.find((p) => p.status === "running") : undefined;
    // 展示区最终渲染：查看的 pending 优先，否则兜底运行中
    const shownPending = viewPending ?? fallbackRunning;
    const shownImageUri = shownPending ? undefined : viewImageUri;
    // 「详情」：在看 pending → 取其请求；在看成功图 → 取 genMeta（旧图/上传无记录则 null）
    const detail = shownPending
        ? { prompt: shownPending.prompt, refs: shownPending.refsMeta || [] }
        : (shownImageUri && genMetaMap?.[shownImageUri]
            ? { prompt: genMetaMap[shownImageUri].prompt, refs: genMetaMap[shownImageUri].refs }
            : null);

    return (
        <div style={{ flex: 1, minWidth: 0, display: "flex", gap: 10, padding: "10px 10px 10px 0", height: "100%", boxSizing: "border-box" }}>

            {/* 区域2：资产列表（不变） */}
            <div style={{ width: 230, display: "flex", flexDirection: "column", gap: 10, ...panel, padding: 10 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: "#fff" }}>{unit}列表</span>
                    <div style={{ display: "flex", gap: 10, fontSize: 11 }}>
                        <span onClick={generateAllBase} title="仅生成未生成与失败的基础形象" style={{ color: "rgba(255,255,255,0.6)", cursor: "pointer" }}>一键生成</span>
                        <span onClick={() => setManageMode((m) => !m)} title="管理：删除资产" style={{ color: manageMode ? accent : "rgba(255,255,255,0.6)", cursor: "pointer" }}>{manageMode ? "完成" : "管理"}</span>
                        <span onClick={newAsset} style={{ color: accent, cursor: "pointer" }}>+ 新建</span>
                    </div>
                </div>
                <input placeholder="搜索名称..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
                    style={{ ...panel, padding: "6px 8px", color: "#fff", fontSize: 12, outline: "none" }} />
                <div ref={listScroll.ref} onScroll={listScroll.onScroll} style={{ display: "flex", flexDirection: "column", gap: 8, overflowY: "auto", flex: 1 }}>
                    {assets.length === 0 ? (
                        <div style={{ padding: "40px 10px", textAlign: "center", color: "rgba(255,255,255,0.4)", fontSize: 12 }}>
                            <p>暂无{unit}数据，请先提取剧本资产</p>
                            <button onClick={() => navigate("/frame1693")} style={{ marginTop: 12, padding: "6px 14px", background: accent, color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 12 }}>前往剧本配置</button>
                        </div>
                    ) : filtered.map((a) => {
                        const isActive = a.id === selectedId;
                        // 未生成形态数 = 基础形象(无图记1) + 各分体中无图者；全部生成则为 0（角标隐藏）
                        const ungenCount = (a.image ? 0 : 1) + (a.variants || []).filter((v: any) => !v.image).length;
                        return (
                            <div key={a.id} onClick={() => { setSelectedId(a.id); setSelectedFormKey("base"); }}
                                onContextMenu={(e) => { e.preventDefault(); setSelectedId(a.id); setCtxSub(null); setCtxMenu({ x: e.clientX, y: e.clientY, asset: a }); }}
                                style={{ ...panel, display: "flex", gap: 8, padding: 8, cursor: "pointer", background: isActive ? "rgba(139,92,246,0.12)" : "rgba(255,255,255,0.03)", borderColor: isActive ? accent : "rgba(255,255,255,0.08)" }}>
                                <div onDoubleClick={(e) => { e.stopPropagation(); if (a.image) openLightbox({ uri: a.image, name: a.name, media: "image" }); }}
                                    title={a.image ? "双击查看大图 / 右键更多操作" : "右键更多操作"}
                                    style={{ position: "relative", width: 40, height: 40, borderRadius: 6, flexShrink: 0, overflow: "hidden", background: a.image ? `center/cover no-repeat url(${a.image})` : "rgba(255,255,255,0.06)" }}>
                                    {assetRunning(a.id) ? (
                                        <div title="生成中" style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.5)" }}>
                                            <div style={{ width: 16, height: 16, border: "2px solid rgba(167,139,250,0.35)", borderTopColor: "#a78bfa", borderRadius: "50%", animation: "Qiji-spin 0.8s linear infinite" }} />
                                        </div>
                                    ) : assetFailed(a.id) ? (
                                        <div title="生成失败" style={{ position: "absolute", top: 0, right: 0, width: 16, height: 16, lineHeight: "16px", textAlign: "center", fontSize: 11, fontWeight: 700, color: "#fff", background: "#ef4444", borderBottomLeftRadius: 6 }}>!</div>
                                    ) : null}
                                    {/* 左上角「未生成形态数」角标：基础形象+分体中尚无图的个数；全部生成(=0)则隐藏 */}
                                    {ungenCount > 0 && (
                                        <div title={`${ungenCount} 个形态未生成（含基础形象与分体）`} style={{ position: "absolute", top: 0, left: 0, minWidth: 14, height: 14, padding: "0 3px", boxSizing: "border-box", lineHeight: "14px", textAlign: "center", fontSize: 9, fontWeight: 700, color: "#fff", background: "rgba(139,92,246,0.9)", borderBottomRightRadius: 6 }}>{ungenCount}</div>
                                    )}
                                </div>
                                <div style={{ minWidth: 0, flex: 1 }}>
                                    {renaming?.kind === "asset" && renaming.id === a.id ? (
                                        <input autoFocus value={renameVal} onClick={(e) => e.stopPropagation()}
                                            onChange={(e) => setRenameVal(e.target.value)} onBlur={commitRename}
                                            onKeyDown={(e) => { if (e.key === "Enter") commitRename(); if (e.key === "Escape") setRenaming(null); }}
                                            style={{ width: "100%", boxSizing: "border-box", ...panel, color: "#fff", fontSize: 13, padding: "2px 6px", outline: "none", borderColor: accent }} />
                                    ) : (
                                        <div title="双击改名" onDoubleClick={(e) => { e.stopPropagation(); startRename("asset", a.id, null, a.name); }}
                                            style={{ color: "#fff", fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{a.name}</div>
                                    )}
                                    <div style={{ color: "rgba(255,255,255,0.45)", fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{(a[textField] || "").slice(0, 22) || "—"}</div>
                                </div>
                                {manageMode && (
                                    <div style={{ display: "flex", flexDirection: "column", gap: 4, alignSelf: "center", flexShrink: 0 }}>
                                        <button onClick={(e) => { e.stopPropagation(); startRename("asset", a.id, null, a.name); }} title="重命名该资产"
                                            style={{ border: "1px solid rgba(139,92,246,0.5)", background: "rgba(139,92,246,0.12)", color: "#c4b5fd", borderRadius: 6, fontSize: 11, padding: "3px 8px", cursor: "pointer" }}>改名</button>
                                        <button onClick={(e) => { e.stopPropagation(); deleteAsset(a.id, a.name); }} title="删除该资产"
                                            style={{ border: "1px solid rgba(248,113,113,0.5)", background: "rgba(248,113,113,0.12)", color: "#f87171", borderRadius: 6, fontSize: 11, padding: "3px 8px", cursor: "pointer" }}>删除</button>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* 区域3：当前资产的分体/造型列表（基础形象为第一个） */}
            <div style={{ width: 200, display: "flex", flexDirection: "column", gap: 10, ...panel, padding: 10 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: "#fff" }}>造型 / 分体</span>
                    <div style={{ display: "flex", gap: 8, fontSize: 11 }}>
                        <span onClick={() => activeAsset && generateAllForms()} title="仅生成未生成与失败的造型" style={{ color: "rgba(255,255,255,0.6)", cursor: "pointer" }}>一键生成</span>
                        <span onClick={() => setManageFormsMode((m) => !m)} title="管理：删除分体（基础形象不可删）" style={{ color: manageFormsMode ? accent : "rgba(255,255,255,0.6)", cursor: "pointer" }}>{manageFormsMode ? "完成" : "管理"}</span>
                        <span onClick={() => { addVariant(); setManageFormsMode(false); }} style={{ color: accent, cursor: "pointer" }}>+ 新建</span>
                    </div>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8, overflowY: "auto", flex: 1 }}>
                    {!activeAsset ? (
                        <div style={{ padding: 24, textAlign: "center", color: "rgba(255,255,255,0.4)", fontSize: 12 }}>请选择左侧{unit}</div>
                    ) : forms.map((f) => {
                        const isActive = f.key === selectedFormKey;
                        const isBusy = isRunning(activeAsset.id, f.variantId);
                        const isFail = isFailed(activeAsset.id, f.variantId);
                        return (
                            <div key={f.key} onClick={() => setSelectedFormKey(f.key)}
                                onContextMenu={(e) => { e.preventDefault(); setSelectedFormKey(f.key); setFormCtx({ x: e.clientX, y: e.clientY, variantId: f.variantId, label: f.label, title: f.title, image: f.image, shareName: f.variantId ? `${activeAsset?.name || f.title}·${f.label}` : f.title }); }}
                                title="右键管理（重命名 / 共享 / 删除）"
                                style={{ ...panel, padding: 8, cursor: "pointer", background: isActive ? "rgba(139,92,246,0.12)" : "rgba(255,255,255,0.03)", borderColor: isActive ? accent : "rgba(255,255,255,0.08)" }}>
                                <div onDoubleClick={(e) => { e.stopPropagation(); if (f.image) openLightbox({ uri: f.image, name: `${f.title}（${f.label}）`, media: "image" }); }}
                                    title={f.image ? "双击查看大图" : undefined}
                                    style={{ position: "relative", width: "100%", aspectRatio: "1/1", borderRadius: 6, overflow: "hidden", background: f.image ? `center/cover no-repeat url(${f.image})` : "rgba(255,255,255,0.06)", display: "flex", alignItems: "center", justifyContent: "center", color: "rgba(255,255,255,0.3)", fontSize: 11 }}>
                                    {isBusy ? (
                                        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6, background: f.image ? "rgba(0,0,0,0.45)" : "transparent", color: "#a78bfa" }}>
                                            <div style={{ width: 18, height: 18, border: "2px solid rgba(167,139,250,0.3)", borderTopColor: "#a78bfa", borderRadius: "50%", animation: "Qiji-spin 0.8s linear infinite" }} />
                                            <span style={{ fontSize: 10 }}>生成中</span>
                                        </div>
                                    ) : isFail ? (
                                        <div title="生成失败（在右侧图片展示区可重试）" style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 5, background: f.image ? "rgba(0,0,0,0.45)" : "transparent", color: "#f87171" }}>
                                            <span style={{ width: 20, height: 20, lineHeight: "20px", textAlign: "center", borderRadius: "50%", background: "rgba(248,113,113,0.18)", border: "1px solid #f87171", fontSize: 12, fontWeight: 700 }}>!</span>
                                            <span style={{ fontSize: 10 }}>失败</span>
                                        </div>
                                    ) : (!f.image ? "未生成" : null)}
                                </div>
                                <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 6 }}>
                                    <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 4, background: f.variantId ? "rgba(255,255,255,0.08)" : accent, color: "#fff", flexShrink: 0 }}>{f.label}</span>
                                    {renaming?.kind === "form" && renaming.id === activeAsset.id && renaming.variantId === f.variantId ? (
                                        <input autoFocus value={renameVal} onClick={(e) => e.stopPropagation()}
                                            onChange={(e) => setRenameVal(e.target.value)} onBlur={commitRename}
                                            onKeyDown={(e) => { if (e.key === "Enter") commitRename(); if (e.key === "Escape") setRenaming(null); }}
                                            style={{ flex: 1, minWidth: 0, ...panel, color: "#fff", fontSize: 11, padding: "2px 6px", outline: "none", borderColor: accent }} />
                                    ) : (
                                        <span title="双击改名" onDoubleClick={(e) => { e.stopPropagation(); startRename("form", activeAsset.id, f.variantId, f.title); }}
                                            style={{ fontSize: 11, color: "rgba(255,255,255,0.6)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flex: 1, minWidth: 0 }}>{f.title}</span>
                                    )}
                                    {manageFormsMode && (
                                        f.variantId ? (
                                            <button onClick={(e) => { e.stopPropagation(); deleteVariant(f.variantId!, f.label); }} title="删除该分体"
                                                style={{ flexShrink: 0, border: "1px solid rgba(248,113,113,0.5)", background: "rgba(248,113,113,0.12)", color: "#f87171", borderRadius: 5, fontSize: 10, padding: "2px 6px", cursor: "pointer" }}>删除</button>
                                        ) : (
                                            <span title="基础形象不可删除" style={{ flexShrink: 0, fontSize: 10, color: "rgba(255,255,255,0.3)" }}>基础</span>
                                        )
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* 区域4：提示词与生成控制 */}
            <div style={{ width: 320, display: "flex", flexDirection: "column", gap: 12, ...panel, padding: 12, overflowY: "auto" }}>
                {!activeForm ? (
                    <div style={{ color: "rgba(255,255,255,0.4)", fontSize: 12, margin: "auto" }}>请选择造型</div>
                ) : (
                    <>
                        <div style={{ color: "#fff", fontSize: 14, fontWeight: 600 }}>{activeForm.title}　<span style={{ fontSize: 11, color: "rgba(255,255,255,0.5)" }}>{activeForm.label}</span></div>

                        {/* 1. 设计理念 / 说明（仅展示，不进入请求） */}
                        {activeForm.desc && (
                            <div style={{ ...panel, padding: 8 }}>
                                <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", marginBottom: 4 }}>设计理念 / 说明（仅展示，不参与生成）</div>
                                <div style={{ fontSize: 11, color: "rgba(255,255,255,0.7)", lineHeight: 1.5 }}>{activeForm.desc}</div>
                            </div>
                        )}

                        {/* 2. 出图提示词（占满剩余空间） */}
                        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
                            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                                <div style={{ fontSize: 11, color: "rgba(255,255,255,0.6)" }}>出图提示词</div>
                                <PromptExpandButton title="编辑出图提示词" getValue={() => activeForm.prompt} onSave={(v) => writePrompt(activeForm, v)} placeholder="出图提示词…" size={12} getPresets={() => listPresetOptions()} />
                            </div>
                            <textarea value={activeForm.prompt} onChange={(e) => writePrompt(activeForm, e.target.value)}
                                onPaste={(e) => {
                                    // 在提示词框粘贴图片 → 自动垫到「垫图素材区」（图生图参考；非图忽略，文本照常粘贴）
                                    const imgs = mediaFilesFromClipboard(e).filter((f) => f.type.startsWith("image/"));
                                    if (imgs.length) { e.preventDefault(); imgs.forEach((f) => addLocalRef(f)); }
                                }}
                                style={{ flex: 1, minHeight: 140, width: "100%", ...panel, color: "#fff", fontSize: 11, lineHeight: 1.5, padding: 8, outline: "none", resize: "none", boxSizing: "border-box" }} />
                        </div>

                        {/* 2b. 垫图素材区（图生图，可选；支持从资产助手拖入） */}
                        <div style={{ position: "relative" }} onDragOver={(e) => e.preventDefault()} onDrop={onRefDrop}>
                            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.6)", marginBottom: 4 }}>垫图素材　<span style={{ color: "rgba(255,255,255,0.35)" }}>（可选，图生图参考；可从资产助手拖入）</span></div>
                            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                                {refImages.map((r) => (
                                    <div key={r.id} title={r.error ? `${r.name || "垫图"}：上传失败` : (r.name || "垫图")}
                                        onDoubleClick={() => !r.error && openLightbox({ uri: r.uri, name: r.name, media: "image" })}
                                        style={{ position: "relative", width: 48, height: 48, borderRadius: 6, overflow: "hidden", border: r.error ? "1px solid #f87171" : "1px solid rgba(255,255,255,0.15)", background: `center/cover no-repeat url(${r.uri})`, cursor: r.error ? "default" : "zoom-in" }}>
                                        {r.uploading && <span style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.5)" }}><span style={{ width: 14, height: 14, border: "2px solid rgba(167,139,250,0.35)", borderTopColor: "#a78bfa", borderRadius: "50%", animation: "Qiji-spin 0.8s linear infinite" }} /></span>}
                                        {r.error && <span style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#f87171", fontSize: 16, fontWeight: 700 }}>✕</span>}
                                        <span onClick={() => mutateRefs((prev) => prev.filter((x) => x.id !== r.id))}
                                            title="移除" style={{ position: "absolute", top: 0, right: 0, width: 16, height: 16, lineHeight: "14px", textAlign: "center", fontSize: 12, color: "#fff", background: "rgba(0,0,0,0.6)", cursor: "pointer" }}>×</span>
                                    </div>
                                ))}
                                <button onClick={() => setRefPickerOpen((v) => !v)} title="添加垫图"
                                    style={{ width: 48, height: 48, borderRadius: 6, border: "1px dashed rgba(255,255,255,0.25)", background: "transparent", color: "rgba(255,255,255,0.5)", cursor: "pointer", fontSize: 20 }}>+</button>
                            </div>
                            {refPickerOpen && (
                                <div style={{ ...panel, position: "absolute", zIndex: 50, left: 0, right: 0, bottom: "100%", marginBottom: 6, padding: 8, background: "#161b26", maxHeight: 300, overflowY: "auto", boxShadow: "0 -8px 24px rgba(0,0,0,0.5)" }}>
                                    <label style={{ display: "block", textAlign: "center", padding: "6px 0", marginBottom: 6, borderRadius: 6, background: "rgba(255,255,255,0.06)", cursor: "pointer", fontSize: 11, color: "#fff" }}>
                                        本地上传
                                        <input type="file" accept="image/*" style={{ display: "none" }}
                                            onChange={(e) => { const f = e.target.files?.[0]; if (f) addLocalRef(f); e.target.value = ""; setRefPickerOpen(false); }} />
                                    </label>
                                    <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", margin: "4px 0" }}>从资产库选</div>
                                    {libraryImages.length === 0 ? (
                                        <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", padding: 4 }}>资产库暂无可用图片</div>
                                    ) : (
                                        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                                            {libraryImages.map((img, i) => (
                                                <div key={i} title={img.name} onClick={() => { mutateRefs((prev) => [...prev, { id: refUid(), uri: img.uri, url: toRefUri(img.uri), name: img.name }]); setRefPickerOpen(false); }}
                                                    style={{ width: 44, height: 44, borderRadius: 6, cursor: "pointer", border: "1px solid rgba(255,255,255,0.12)", background: `center/cover no-repeat url(${img.uri})` }} />
                                            ))}
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>

                        {/* 3a. 绑定音色（独占一行）：上传音频绑定到角色；资产匹配时自动加入素材区 + 写入声音参考图例 */}
                        {showVoice && activeAsset && (
                            <div>
                                <div style={{ fontSize: 11, color: "rgba(255,255,255,0.6)", marginBottom: 4 }}>绑定音色　<span style={{ color: "rgba(255,255,255,0.35)" }}>（音频绑定到该角色；视频匹配资产时自动加入素材区并写入「@角色的声音参考@音频」）</span></div>
                                {activeAsset.voiceUri ? (
                                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                        <audio src={activeAsset.voiceUri} controls style={{ flex: 1, minWidth: 0, height: 32 }} />
                                        <span style={{ fontSize: 11, color: "rgba(255,255,255,0.6)", maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={activeAsset.voiceName || "已绑定音色"}>{activeAsset.voiceName || "已绑定音色"}</span>
                                        <label title="替换为其它音频" style={{ ...panel, color: "#c4b5fd", fontSize: 11, padding: "6px 10px", cursor: uploadingVoice ? "not-allowed" : "pointer", whiteSpace: "nowrap" }}>
                                            {uploadingVoice ? "上传中…" : "替换"}
                                            <input type="file" accept="audio/*" style={{ display: "none" }} disabled={uploadingVoice} onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleVoiceUpload(f); e.target.value = ""; }} />
                                        </label>
                                        <button onClick={removeVoice} title="解除绑定" style={{ ...panel, color: "#f8c8c8", fontSize: 11, padding: "6px 10px", cursor: "pointer", whiteSpace: "nowrap" }}>移除</button>
                                    </div>
                                ) : (
                                    <div style={{ display: "flex", gap: 8 }}>
                                        <span style={{ flex: 1, ...panel, color: "rgba(255,255,255,0.5)", fontSize: 11, padding: "6px 8px", display: "flex", alignItems: "center" }}>未绑定音色</span>
                                        <button disabled title="TTS 音色生成暂未实现" style={{ ...panel, color: "rgba(255,255,255,0.4)", fontSize: 11, padding: "6px 10px", cursor: "not-allowed" }}>音色生成</button>
                                        <label title="上传本地音频绑定到该角色" style={{ ...panel, color: "#c4b5fd", fontSize: 11, padding: "6px 10px", cursor: uploadingVoice ? "not-allowed" : "pointer", borderColor: accent, whiteSpace: "nowrap" }}>
                                            {uploadingVoice ? "上传中…" : "本地上传"}
                                            <input type="file" accept="audio/*" style={{ display: "none" }} disabled={uploadingVoice} onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleVoiceUpload(f); e.target.value = ""; }} />
                                        </label>
                                    </div>
                                )}
                            </div>
                        )}

                        {/* 3b. 出图要求（与提示词一起进入生成请求） */}
                        <div>
                            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.6)", marginBottom: 4 }}>出图要求</div>
                            <ModelPicker cap="image" label="出图模型" style={{ marginBottom: 8 }} />
                            <div style={{ display: "flex", gap: 8 }}>
                                <label style={{ flex: 1, minWidth: 0 }}>
                                    <div style={{ fontSize: 10, color: "rgba(255,255,255,0.45)", marginBottom: 2 }}>质量</div>
                                    <select value={quality} onChange={(e) => setQuality(e.target.value)}
                                        style={{ width: "100%", ...panel, color: "#fff", fontSize: 11, padding: "6px 6px", outline: "none" }}>
                                        {QUALITIES.map((q) => <option key={q} value={q} style={{ background: "#1f1f2e" }}>{q}</option>)}
                                    </select>
                                </label>
                                <label style={{ flex: 1, minWidth: 0 }}>
                                    <div style={{ fontSize: 10, color: "rgba(255,255,255,0.45)", marginBottom: 2 }}>比例</div>
                                    <select value={aspect} onChange={(e) => setAspect(e.target.value)}
                                        style={{ width: "100%", ...panel, color: "#fff", fontSize: 11, padding: "6px 6px", outline: "none" }}>
                                        {ASPECTS.map((a) => <option key={a.v} value={a.v} style={{ background: "#1f1f2e" }}>{a.label}</option>)}
                                    </select>
                                </label>
                                <label style={{ flex: 1, minWidth: 0 }}>
                                    <div style={{ fontSize: 10, color: "rgba(255,255,255,0.45)", marginBottom: 2 }}>分辨率</div>
                                    <select value={resolution} onChange={(e) => setResolution(e.target.value)}
                                        style={{ width: "100%", ...panel, color: "#fff", fontSize: 11, padding: "6px 6px", outline: "none" }}>
                                        {resOptions.map((r) => <option key={r.v} value={r.v} style={{ background: "#1f1f2e" }}>{r.label}</option>)}
                                    </select>
                                </label>
                            </div>
                        </div>

                        <div style={{ display: "flex", gap: 10 }}>
                            <button onClick={() => activeAsset && generateForm(activeAsset.id, activeForm)} title="可重复提交，每次生成会在右侧历史区新增一个占位"
                                style={{ flex: 1, padding: "9px 0", background: accent, color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 12 }}>
                                生成形象
                            </button>
                        </div>
                    </>
                )}
            </div>

            {/* 区域5：图片展示区（主图 + 历史，可选主图 / 失败记录） */}
            <div style={{ flex: 1, minWidth: 0, position: "relative", display: "flex", flexDirection: "column", gap: 12, ...panel, padding: 12 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#fff" }}>图片展示{activeForm ? `　·　${activeForm.title}（${activeForm.label}）` : ""}</div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        {shownImageUri && imgDims && (
                            <span style={{ fontSize: 11, color: "rgba(255,255,255,0.6)", fontFamily: "monospace", background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 5, padding: "2px 8px" }}>
                                {imgDims.w}×{imgDims.h}
                            </span>
                        )}
                        {/* 详情：查看当前图（或选中的在途/失败记录）请求时的提示词 + 垫图 */}
                        <button title="查看当前图片请求时的提示词与垫图信息" onClick={() => setDetailOpen((v) => !v)} disabled={!activeForm}
                            style={{ fontSize: 11, padding: "4px 10px", borderRadius: 6, cursor: activeForm ? "pointer" : "not-allowed", border: `1px solid ${detailOpen ? accent : "rgba(255,255,255,0.18)"}`, background: detailOpen ? "rgba(139,92,246,0.18)" : "rgba(255,255,255,0.05)", color: detailOpen ? "#c4b5fd" : "#fff", opacity: activeForm ? 1 : 0.5, whiteSpace: "nowrap" }}>详情</button>
                        {/* 上传本地图片作为当前资产形象（上传 OSS→入历史并设主图）*/}
                        <label title="上传本地图片作为当前造型的资产形象" style={{ fontSize: 11, padding: "4px 10px", borderRadius: 6, cursor: activeForm && !uploadingImg ? "pointer" : "not-allowed", border: `1px solid ${accent}`, background: "rgba(139,92,246,0.12)", color: "#c4b5fd", opacity: activeForm && !uploadingImg ? 1 : 0.5, whiteSpace: "nowrap" }}>
                            {uploadingImg ? "上传中…" : "上传本地图片"}
                            <input type="file" accept="image/*" style={{ display: "none" }} disabled={!activeForm || uploadingImg}
                                onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadImageToForm(f); e.target.value = ""; }} />
                        </label>
                        {/* 保存当前资产（默认名=资产名+历史编号）*/}
                        <button title="保存当前显示的图片到本地（默认名=资产名+历史记录编号）" onClick={saveCurrentImage} disabled={!activeForm?.image}
                            style={{ fontSize: 11, padding: "4px 10px", borderRadius: 6, cursor: activeForm?.image ? "pointer" : "not-allowed", border: "1px solid rgba(255,255,255,0.18)", background: "rgba(255,255,255,0.05)", color: "#fff", opacity: activeForm?.image ? 1 : 0.5, whiteSpace: "nowrap" }}>保存当前资产</button>
                    </div>
                </div>
                {!activeForm ? (
                    <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "rgba(255,255,255,0.4)", fontSize: 12 }}>请选择左侧造型</div>
                ) : (
                    <>
                        <div
                            onWheel={(e) => { if (shownImageUri) setImgScale((s) => Math.min(8, Math.max(0.5, s * (e.deltaY < 0 ? 1.1 : 0.9)))); }}
                            onMouseDown={(e) => { if (imgScale !== 1) dragRef.current = { x: e.clientX, y: e.clientY, ox: imgOffset.x, oy: imgOffset.y }; }}
                            onMouseMove={(e) => { if (dragRef.current) setImgOffset({ x: dragRef.current.ox + (e.clientX - dragRef.current.x), y: dragRef.current.oy + (e.clientY - dragRef.current.y) }); }}
                            onMouseUp={() => { dragRef.current = null; }}
                            onMouseLeave={() => { dragRef.current = null; }}
                            onDoubleClick={() => { setImgScale(1); setImgOffset({ x: 0, y: 0 }); }}
                            style={{ flex: 1, minHeight: 0, borderRadius: 8, background: "rgba(255,255,255,0.04)", display: "flex", alignItems: "center", justifyContent: "center", color: "rgba(255,255,255,0.35)", fontSize: 13, overflow: "hidden" }}>
                            {/* 展示区按 viewSel 显示：成功图 / 选中的在途（生成中·失败原因）；一次只一个，互不叠加 */}
                            {shownImageUri ? (
                                <img src={shownImageUri} alt={activeForm.title} title="滚轮缩放·拖动平移·双击复位" draggable={false}
                                    onDragStart={(e) => e.preventDefault()}
                                    ref={(el) => {
                                        if (el && el.complete && el.naturalWidth && (!imgDims || imgDims.w !== el.naturalWidth || imgDims.h !== el.naturalHeight)) {
                                            setImgDims({ w: el.naturalWidth, h: el.naturalHeight });
                                        }
                                    }}
                                    onLoad={(e) => setImgDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
                                    style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", transform: `translate(${imgOffset.x}px, ${imgOffset.y}px) scale(${imgScale})`, transition: dragRef.current ? "none" : "transform 0.06s", cursor: imgScale > 1 ? "grab" : "default", userSelect: "none" }} />
                            ) : shownPending?.status === "running" ? (
                                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, color: "#c4b5fd", fontSize: 13 }}>
                                    <div style={{ width: 28, height: 28, border: "3px solid rgba(167,139,250,0.3)", borderTopColor: "#a78bfa", borderRadius: "50%", animation: "Qiji-spin 0.8s linear infinite" }} />
                                    生成中…
                                </div>
                            ) : shownPending ? (
                                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, padding: 24, maxWidth: 560 }}>
                                    <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#f87171", fontSize: 14, fontWeight: 600 }}>
                                        <span style={{ width: 22, height: 22, lineHeight: "22px", textAlign: "center", borderRadius: "50%", background: "rgba(248,113,113,0.18)", border: "1px solid #f87171", fontSize: 13 }}>!</span>
                                        {shownPending.recoverable ? "服务端异常" : "生成失败"}
                                    </div>
                                    <div style={{ color: "#fca5a5", fontSize: 12, lineHeight: 1.6, textAlign: "center", whiteSpace: "pre-wrap", wordBreak: "break-word", userSelect: "text", background: "rgba(248,113,113,0.08)", border: "1px solid rgba(248,113,113,0.3)", borderRadius: 8, padding: "10px 14px" }}>
                                        {shownPending.error || "生成失败（无错误详情）"}
                                    </div>
                                    <div style={{ display: "flex", gap: 12 }}>
                                        {/* 服务端异常（lost）：优先「重连原任务」——凭原 taskId 找回结果，不重新生成、不再扣费 */}
                                        {shownPending.recoverable && (
                                            <button onClick={() => recallPendingGeneration(shownPending.id)}
                                                style={{ padding: "6px 18px", background: accent, color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 12 }}>重连原任务</button>
                                        )}
                                        <button onClick={() => retryGeneration(shownPending.id)}
                                            style={{ padding: "6px 18px", background: shownPending.recoverable ? "transparent" : accent, color: shownPending.recoverable ? "rgba(255,255,255,0.85)" : "#fff", border: shownPending.recoverable ? "1px solid rgba(255,255,255,0.3)" : "none", borderRadius: 6, cursor: "pointer", fontSize: 12 }}>{shownPending.recoverable ? "重新生成" : "重试"}</button>
                                        <button onClick={() => { const rid = shownPending.id; setViewSel(null); removePendingGen(rid); }}
                                            style={{ padding: "6px 18px", background: "transparent", color: "rgba(255,255,255,0.6)", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 6, cursor: "pointer", fontSize: 12 }}>删除</button>
                                    </div>
                                </div>
                            ) : "暂无图片，点击「生成形象」"}
                        </div>
                        <div>
                            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", marginBottom: 6 }}>历史记录（点击设为主图；生成中/失败的任务也在此展示，点选可在上方查看）</div>
                            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                                {activeForm.images.filter(Boolean).map((uri, i) => {
                                    const isMain = uri === activeForm.image;
                                    const isViewed = viewSel?.kind === "image" && viewSel.uri === uri;
                                    return (
                                        <div key={i} onClick={() => { if (activeAsset) { setAssetMainImage(cat, activeAsset.id, activeForm.variantId, uri); setViewSel({ kind: "image", uri }); } }}
                                            onDoubleClick={() => openLightbox({ uri, name: `${activeForm.title}（${activeForm.label}）`, media: "image" })}
                                            title={isMain ? "当前主图（双击查看大图）" : "单击设为主图 / 双击查看大图"}
                                            style={{ width: 64, height: 64, borderRadius: 6, cursor: "pointer", background: `center/cover no-repeat url(${uri})`, border: (isMain || isViewed) ? `2px solid ${accent}` : "2px solid transparent", boxShadow: isMain ? "0 0 0 1px rgba(139,92,246,0.4)" : "none" }} />
                                    );
                                })}
                                {/* 在途占位：每条请求一个独立 64×64 占位（运行中=转圈 / 失败=红「!」），可点选；
                                    失败原因不在占位内显示，点选后在上方展示区显示——一个请求一个记录，不叠加不干扰 */}
                                {activeAsset && pendingFor(activeAsset.id, activeForm.variantId).map((p) => {
                                    const sel = viewSel?.kind === "pending" && viewSel.id === p.id;
                                    return p.status === "running" ? (
                                        <div key={p.id} onClick={() => setViewSel({ kind: "pending", id: p.id })} title="生成中（点击查看；切页/关软件不丢，完成自动回填）"
                                            style={{ width: 64, height: 64, borderRadius: 6, cursor: "pointer", border: sel ? `2px solid ${accent}` : "2px dashed rgba(139,92,246,0.5)", background: "rgba(139,92,246,0.08)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4, color: "#a78bfa", fontSize: 10 }}>
                                            <div style={{ width: 16, height: 16, border: "2px solid rgba(167,139,250,0.3)", borderTopColor: "#a78bfa", borderRadius: "50%", animation: "Qiji-spin 0.8s linear infinite" }} />
                                            生成中
                                        </div>
                                    ) : (
                                        <div key={p.id} onClick={() => setViewSel({ kind: "pending", id: p.id })} title="生成失败（点击查看失败原因）"
                                            style={{ width: 64, height: 64, borderRadius: 6, cursor: "pointer", border: sel ? "2px solid #f87171" : "2px solid rgba(248,113,113,0.55)", background: "rgba(248,113,113,0.12)", boxShadow: sel ? "0 0 0 1px rgba(248,113,113,0.5)" : "none", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4, color: "#fca5a5", fontSize: 10 }}>
                                            <span style={{ width: 20, height: 20, lineHeight: "20px", textAlign: "center", borderRadius: "50%", background: "rgba(248,113,113,0.18)", border: "1px solid #f87171", fontSize: 12, fontWeight: 700 }}>!</span>
                                            失败
                                        </div>
                                    );
                                })}
                                {activeForm.images.filter(Boolean).length === 0 && (!activeAsset || pendingFor(activeAsset.id, activeForm.variantId).length === 0) && (
                                    <span style={{ color: "rgba(255,255,255,0.3)", fontSize: 12 }}>暂无历史</span>
                                )}
                            </div>
                        </div>
                    </>
                )}

                {/* 详情面板：当前查看图片/记录请求时的提示词 + 垫图（绝对定位浮层，不挤压布局） */}
                {detailOpen && activeForm && (
                    <div style={{ position: "absolute", zIndex: 60, top: 48, right: 12, width: 320, maxHeight: "calc(100% - 64px)", overflowY: "auto", ...panel, background: "#161b26", boxShadow: "0 10px 40px rgba(0,0,0,0.6)", padding: 12 }}>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                            <span style={{ fontSize: 12, fontWeight: 600, color: "#fff" }}>本次请求详情{shownPending ? (shownPending.status === "running" ? "（生成中）" : "（失败记录）") : ""}</span>
                            <span onClick={() => setDetailOpen(false)} title="关闭" style={{ cursor: "pointer", color: "rgba(255,255,255,0.5)", fontSize: 14, lineHeight: 1 }}>×</span>
                        </div>
                        {detail ? (
                            <>
                                <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", marginBottom: 4 }}>出图提示词</div>
                                <div style={{ ...panel, padding: 8, marginBottom: 10, fontSize: 11, lineHeight: 1.5, color: "rgba(255,255,255,0.85)", whiteSpace: "pre-wrap", wordBreak: "break-word", userSelect: "text", maxHeight: 220, overflowY: "auto" }}>
                                    {detail.prompt?.trim() || "（无提示词）"}
                                </div>
                                <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", marginBottom: 4 }}>垫图（{detail.refs.length}）</div>
                                {detail.refs.length === 0 ? (
                                    <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)" }}>无垫图（文生图）</div>
                                ) : (
                                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                                        {detail.refs.map((r, i) => (
                                            <div key={i} title={r.name || r.id || "垫图"} onDoubleClick={() => openLightbox({ uri: r.uri, name: r.name, media: "image" })}
                                                style={{ width: 56, display: "flex", flexDirection: "column", gap: 2, cursor: "zoom-in" }}>
                                                <div style={{ width: 56, height: 56, borderRadius: 6, border: "1px solid rgba(255,255,255,0.15)", background: `center/cover no-repeat url(${r.uri})` }} />
                                                <span style={{ fontSize: 9, color: "rgba(255,255,255,0.5)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.name || r.id || "垫图"}</span>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </>
                        ) : (
                            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.45)", lineHeight: 1.6 }}>无请求记录（可能为上传的图片，或本功能上线前生成的旧图）。</div>
                        )}
                    </div>
                )}
            </div>

            {/* 造型卡右键管理菜单：重命名 / 删除（基础形象不可删） */}
            {formCtx && (
                <>
                    <div onClick={() => setFormCtx(null)} onContextMenu={(e) => { e.preventDefault(); setFormCtx(null); }}
                        style={{ position: "fixed", inset: 0, zIndex: 9200 }} />
                    <div style={{ position: "fixed", zIndex: 9201, left: Math.min(formCtx.x, window.innerWidth - 170), top: Math.min(formCtx.y, window.innerHeight - 150), width: 160, ...panel, background: "#161b26", boxShadow: "0 10px 40px rgba(0,0,0,0.6)", padding: 6 }}>
                        {(() => {
                            const item: React.CSSProperties = { padding: "8px 10px", borderRadius: 6, cursor: "pointer", fontSize: 12, color: "#fff" };
                            const hov = (e: React.MouseEvent, on: boolean) => (e.currentTarget as HTMLElement).style.background = on ? "rgba(255,255,255,0.07)" : "transparent";
                            return (
                                <>
                                    <div style={item} onMouseEnter={(e) => hov(e, true)} onMouseLeave={(e) => hov(e, false)}
                                        onClick={() => { if (activeAsset) startRename("form", activeAsset.id, formCtx.variantId, formCtx.title); setFormCtx(null); }}>重命名</div>
                                    <div style={{ ...item, opacity: formCtx.image ? 1 : 0.4 }} onMouseEnter={(e) => hov(e, true)} onMouseLeave={(e) => hov(e, false)}
                                        title={formCtx.image ? "把该造型图登记到共享文件夹（只存 OSS 记录，不复制文件）" : "该造型还没有图"}
                                        onClick={() => {
                                            const img = formCtx.image, nm = formCtx.shareName;
                                            setFormCtx(null);
                                            if (!img) return;
                                            const it = sharedItemFromUri(img, nm);
                                            openSharedPick(it ? [it] : [], it ? 0 : 1);
                                        }}>添加到共享资产</div>
                                    {formCtx.variantId ? (
                                        <div style={{ ...item, color: "#f87171" }} onMouseEnter={(e) => hov(e, true)} onMouseLeave={(e) => hov(e, false)}
                                            onClick={() => { const vid = formCtx.variantId!, lb = formCtx.label; setFormCtx(null); deleteVariant(vid, lb); }}>删除</div>
                                    ) : (
                                        <div style={{ ...item, color: "rgba(255,255,255,0.35)", cursor: "default" }} title="基础形象随资产存在，不可单独删除">基础形象不可删</div>
                                    )}
                                </>
                            );
                        })()}
                    </div>
                </>
            )}

            {/* #8/#11 资产右键菜单：导出 / 改名 / 更改分组 / 用分体替换基础形象 / 本地上传为新资产 */}
            {ctxMenu && (
                <>
                    <div onClick={closeCtx} onContextMenu={(e) => { e.preventDefault(); closeCtx(); }}
                        style={{ position: "fixed", inset: 0, zIndex: 9200 }} />
                    <div style={{ position: "fixed", zIndex: 9201, left: Math.min(ctxMenu.x, window.innerWidth - 220), top: Math.min(ctxMenu.y, window.innerHeight - 320), width: 200, ...panel, background: "#161b26", boxShadow: "0 10px 40px rgba(0,0,0,0.6)", padding: 6 }}>
                        {(() => {
                            const a = ctxMenu.asset;
                            const item: React.CSSProperties = { padding: "8px 10px", borderRadius: 6, cursor: "pointer", fontSize: 12, color: "#fff", display: "flex", justifyContent: "space-between", alignItems: "center" };
                            const hov = (e: React.MouseEvent, on: boolean) => (e.currentTarget as HTMLElement).style.background = on ? "rgba(255,255,255,0.07)" : "transparent";
                            const variantsWithImg = (a.variants || []).filter((v: any) => v.image);
                            return (
                                <>
                                    <div style={item} onMouseEnter={(e) => hov(e, true)} onMouseLeave={(e) => hov(e, false)}
                                        onClick={() => { closeCtx(); startRename("asset", a.id, null, a.name); }}>改名</div>
                                    <div style={item} onMouseEnter={(e) => hov(e, true)} onMouseLeave={(e) => hov(e, false)}
                                        onClick={() => exportAsset(a)}>导出图片（{a.name}）</div>
                                    <div style={item} onMouseEnter={(e) => hov(e, true)} onMouseLeave={(e) => hov(e, false)}
                                        title="检查该资产的图（主图/历史/造型）云端直链是否正常，死链且本机有本地副本则自动修复"
                                        onClick={() => { closeCtx(); void runAssetCheck(assetEntityTargets(a), `检查素材（${a.name}）`); }}>检查素材</div>
                                    <div style={item} onMouseEnter={(e) => hov(e, true)} onMouseLeave={(e) => hov(e, false)}
                                        title="把该资产主图登记到共享文件夹（只存 OSS 记录，不复制文件）"
                                        onClick={() => { closeCtx(); const it = sharedItemFromUri(a.image, a.name); openSharedPick(it ? [it] : [], it ? 0 : 1); }}>添加到共享资产</div>
                                    <div style={{ ...item, position: "relative" }} onMouseEnter={(e) => { hov(e, true); setCtxSub("group"); }} onMouseLeave={(e) => hov(e, false)}>
                                        <span>更改分组</span><span style={{ color: "rgba(255,255,255,0.4)" }}>▸</span>
                                        {ctxSub === "group" && (
                                            <div onMouseLeave={() => setCtxSub(null)} style={{ position: "absolute", left: "100%", top: -6, width: 120, ...panel, background: "#1b2130", boxShadow: "0 10px 30px rgba(0,0,0,0.6)", padding: 6 }}>
                                                {ALL_CATS.filter((c) => c !== cat).map((c) => (
                                                    <div key={c} style={item} onMouseEnter={(e) => hov(e, true)} onMouseLeave={(e) => hov(e, false)}
                                                        onClick={() => moveAssetToCat(a, c)}>{CAT_LABEL[c]}</div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                    <div style={{ ...item, position: "relative", opacity: variantsWithImg.length ? 1 : 0.4 }} onMouseEnter={(e) => { hov(e, true); if (variantsWithImg.length) setCtxSub("replace"); }} onMouseLeave={(e) => hov(e, false)}>
                                        <span>用分体替换基础形象</span><span style={{ color: "rgba(255,255,255,0.4)" }}>▸</span>
                                        {ctxSub === "replace" && variantsWithImg.length > 0 && (
                                            <div onMouseLeave={() => setCtxSub(null)} style={{ position: "absolute", left: "100%", top: -6, width: 160, maxHeight: 260, overflowY: "auto", ...panel, background: "#1b2130", boxShadow: "0 10px 30px rgba(0,0,0,0.6)", padding: 6 }}>
                                                {variantsWithImg.map((v: any) => (
                                                    <div key={v.id} style={{ ...item, gap: 8, justifyContent: "flex-start" }} onMouseEnter={(e) => hov(e, true)} onMouseLeave={(e) => hov(e, false)}
                                                        onClick={() => replaceBaseFromVariant(a, v.image)}>
                                                        <span style={{ width: 28, height: 28, borderRadius: 4, flexShrink: 0, background: `center/cover no-repeat url(${v.image})` }} />
                                                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{v.label || v.name || "分体"}</span>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                    <label style={{ ...item }} onMouseEnter={(e) => hov(e, true)} onMouseLeave={(e) => hov(e, false)}>
                                        本地上传为新资产
                                        <input type="file" accept="image/*" style={{ display: "none" }}
                                            onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadLocalAsset(f); e.target.value = ""; }} />
                                    </label>
                                </>
                            );
                        })()}
                    </div>
                </>
            )}
        </div>
    );
};

export default AssetWorkbench;
