import { useNavigate } from "react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useProjectStore } from "@/store/projectStore";
import { useCatalogStore } from "@/store/catalogStore";
import { useModeFeatures } from "@/store/connectionStore";
import { restoreRouteAfterLoad } from "@/views/utils/utils";
import ModelPicker from "@/components/ModelPicker";
import TemplatePicker from "@/components/TemplatePicker";
import { QUICK_SPLIT_CHOICES, QUICK_NN_ID } from "@/lib/splitChoices";
import { aspectFromName } from "@/lib/templateAspect";
import type { ProjectModelConfig } from "@/services/projectFile";
import "@/styles/Frame164.css";

// ── 第243轮：新建项目即确定 影片比例 / 各步模型 / 提示词方案（全部为项目级预填，进入项目后各界面仍可改） ──
const ASPECT_CHOICES = [
    { v: "16:9", label: "16:9 横屏", w: 46, h: 26 },
    { v: "9:16", label: "9:16 竖屏", w: 26, h: 46 },
    { v: "1:1", label: "1:1 方形", w: 36, h: 36 },
];
// ⚠ 第245轮补充：文字/字段颜色走 styles.css 的 qiji-sec-title/qiji-field-* 三层 CSS（深色默认/浅色页面/
// 深色弹窗孤岛）——新建项目页支持浅色主题，颜色写内联会压过浅色规则变成白字贴白底，勿回退。
const secTitleStyle: React.CSSProperties = { fontSize: 14, fontWeight: 600, marginBottom: 10 };
const hintStyle: React.CSSProperties = { marginTop: 6, fontSize: 11, lineHeight: 1.5 };
const noteStyle: React.CSSProperties = { marginTop: 6, fontSize: 11, lineHeight: 1.5 };
const pickerLabelStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4, fontSize: 11 };
const pickerSelectStyle: React.CSSProperties = { borderRadius: 6, padding: "6px 8px", fontSize: 12, outline: "none", cursor: "pointer" };
const optStyle: React.CSSProperties = { background: "#1f1f2e" };

/** 未配置管理端 / catalog 未含画风时的本地兜底画风（与管理端默认画风预设一致） */
const FALLBACK_STYLES = [
    { id: "3D国漫", name: "3D国漫 (动漫半写实)", style: "3D国风动画", image: undefined as string | undefined },
    { id: "2D手绘", name: "2D手绘 (二次元日系)", style: "2D日漫剧场版", image: undefined as string | undefined },
    { id: "真人写实", name: "真人写实 (电影级大片)", style: "电影级写实", image: undefined as string | undefined },
];

/** 把上传的图片压缩成缩略图 data URL（最长边 512px，webp 0.85），便于随项目文件与本地列表持久化。 */
async function fileToThumbnail(file: File, maxSize = 512): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const img = new Image();
            img.onload = () => {
                let { width, height } = img;
                if (width >= height && width > maxSize) {
                    height = Math.round((height * maxSize) / width);
                    width = maxSize;
                } else if (height > width && height > maxSize) {
                    width = Math.round((width * maxSize) / height);
                    height = maxSize;
                }
                const canvas = document.createElement("canvas");
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext("2d");
                if (!ctx) { reject(new Error("无法创建画布上下文")); return; }
                ctx.drawImage(img, 0, 0, width, height);
                resolve(canvas.toDataURL("image/webp", 0.85));
            };
            img.onerror = reject;
            img.src = reader.result as string;
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

const Frame164 = () => {
    const navigate = useNavigate();
    // 模式开关（服务端按用户下发）：被关的模式隐藏对应「进入」按钮；仅开单模式时按钮文案退化为「创建项目」
    const { assetMode, canvasMode, editorMode } = useModeFeatures();
    const multiMode = [assetMode, canvasMode, editorMode].filter(Boolean).length > 1;

    const artStylesRaw = useCatalogStore((s) => s.artStyles());

    // 画风来源：管理端 catalog 的「画风」分类模板；无则本地兜底。统一成 {id,name,style,image}。
    const styleOptions = useMemo(() => {
        if (artStylesRaw.length > 0) {
            return artStylesRaw.map((t) => ({
                id: t.id,
                name: t.name,
                style: t.body || t.bodyPreview || t.name,
                image: t.images && t.images.length > 0 ? t.images[0] : undefined,
            }));
        }
        return FALLBACK_STYLES;
    }, [artStylesRaw]);

    const [name, setName] = useState("");
    const [cover, setCover] = useState("");
    const [artStyleId, setArtStyleId] = useState("");
    const [dragOver, setDragOver] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // ── 第243轮：影片比例 / 各步模型 / 提示词方案（新建即确定；只是预填项目级设置，不锁死） ──
    const [filmAspect, setFilmAspect] = useState("16:9");
    const [modelSel, setModelSel] = useState<{ text?: string; image?: string; video?: string }>({});
    const [episodeTplId, setEpisodeTplId] = useState(QUICK_NN_ID); // 剧集拆分方式（默认 快速·n-n，第121轮用户定）
    const [assetTplId, setAssetTplId] = useState("");              // 资产拆分模板；""=跟随管理端默认款（isDefault）
    const [sameSource, setSameSource] = useState(false);           // 图视同源
    const [inferTplId, setInferTplId] = useState("");              // 多卡推理模板（storyboard.toVideoPrompt）
    const [unifiedTplId, setUnifiedTplId] = useState("");          // 同源多卡模板（storyboard.unified）

    // 模板清单（口径与 Frame1693 一致：资产拆分=script.analyze 且非「内部」；剧集=「剧集」分类）
    const allTemplates = useCatalogStore((s) => s.catalog?.templates);
    const extractTemplates = useMemo(
        () => (allTemplates ?? []).filter((t) => t.purpose === "script.analyze" && t.category !== "内部"),
        [allTemplates],
    );
    const episodeTemplates = useMemo(() => (allTemplates ?? []).filter((t) => t.category === "剧集"), [allTemplates]);

    // 比例决定链（用户定稿）：模板名内嵌比例（如「资产拆分9:16」）> 项目默认影片比例。
    // 这里解析「实际将使用的模板」（显式选中款，空=默认款）的名称，给出提示并在创建时落地。
    const defExtract = extractTemplates.find((t) => t.isDefault) ?? extractTemplates[0];
    const effAssetTpl = (assetTplId ? extractTemplates.find((t) => t.id === assetTplId) : undefined) ?? defExtract;
    const assetTplAspect = aspectFromName(effAssetTpl?.name);
    const inferPurpose = sameSource ? "storyboard.unified" : "storyboard.toVideoPrompt";
    const inferTpls = useMemo(() => (allTemplates ?? []).filter((t) => t.purpose === inferPurpose), [allTemplates, inferPurpose]);
    const curInferTplId = sameSource ? unifiedTplId : inferTplId;
    const effInferTpl = (curInferTplId ? inferTpls.find((t) => t.id === curInferTplId) : undefined)
        ?? inferTpls.find((t) => t.isDefault) ?? inferTpls[0];
    const inferTplAspect = aspectFromName(effInferTpl?.name);

    // catalog 异步到达后，确保选中项落在可选范围内（默认第一个）。
    useEffect(() => {
        if (styleOptions.length > 0 && !styleOptions.some((o) => o.id === artStyleId)) {
            setArtStyleId(styleOptions[0].id);
        }
    }, [styleOptions, artStyleId]);

    const selectedStyle = styleOptions.find((o) => o.id === artStyleId) || styleOptions[0];

    const handleFile = async (file?: File | null) => {
        if (!file) return;
        if (!/\.(jpe?g|png|webp)$/i.test(file.name) && !/(jpe?g|png|webp)$/i.test(file.type)) {
            alert("仅支持 JPG、PNG、WEBP 格式");
            return;
        }
        if (file.size > 5 * 1024 * 1024) {
            alert("图片大小不能超过 5MB");
            return;
        }
        try {
            const thumb = await fileToThumbnail(file);
            setCover(thumb);
        } catch (err) {
            console.error("封面处理失败:", err);
        }
    };

    // 创建项目并落盘（资产模式 / 画布模式共用），返回后由调用方决定跳转视图。
    const createProject = async () => {
        const projName = name.trim() || "未命名项目";
        const store = useProjectStore.getState();
        store.newProject();
        store.setName(projName);
        store.setCoverImage(cover);
        store.setVisualStyle(selectedStyle?.style || "国漫电影感");
        // 第174轮：记录所选画风预设 id（决定资产拆分自动附加的【画风前缀】胶囊）。
        // 仅 catalog 画风有真实预设 id；本地兜底画风（未连管理端）id 不在预设库 → 存空、不挂胶囊。
        store.setVisualStyleId(artStylesRaw.length > 0 && selectedStyle ? selectedStyle.id : "");

        // 第243轮：新建即确定 各步模型 / 影片比例 / 提示词方案（项目级预填，进入项目后各界面仍可改）。
        // 模型只写用户显式选过的（留空=沿用「自动取第一个可用」的既有默认，catalog 顺序变化时自动跟随）。
        const pmc: ProjectModelConfig = {};
        if (modelSel.text) pmc.text = modelSel.text;
        if (modelSel.image) pmc.image = modelSel.image;
        if (modelSel.video) pmc.video = modelSel.video;
        if (Object.keys(pmc).length > 0) store.setProjectModelConfig(pmc);
        // 比例决定链：推理模板名内嵌比例（如「同源推理9:16」）优先于所选影片比例（用户定稿）；
        // 资产出图比例由 AssetWorkbench/RTC 按「资产拆分模板内嵌比例 > 项目默认」读取时解析，这里不写。
        const effAspect = inferTplAspect ?? filmAspect;
        store.setMediaSettings({
            imageAspect: effAspect,
            aspect: effAspect,
            episodeTplId,
            imgVideoSameSource: sameSource,
            ...(assetTplId ? { assetExtractTplId: assetTplId } : {}),
            ...(sameSource ? (unifiedTplId ? { unifiedTplId } : {}) : (inferTplId ? { inferTplId } : {})),
        });

        await store.save(true);
    };

    const handleEnterAsset = async () => {
        await createProject();
        navigate("/frame1693");
    };

    const handleEnterCanvas = async () => {
        await createProject();
        navigate("/frame-canvas");
    };

    const handleEnterEditor = async () => {
        await createProject();
        navigate("/frame-editor");
    };

    const handleCancel = () => {
        navigate("/");
    };

    // 导入已有项目（.Qiji）：新建项目并复制素材（源项目不动），成功即进入新项目
    const handleImport = async () => {
        const ok = await useProjectStore.getState().importProject();
        if (ok) navigate(restoreRouteAfterLoad());
    };

    return (
        <div className="scroll-container">
            <div id="16_4" className="Pixso-frame-16_4">
                <div id="16_5" className="Pixso-frame-16_5" style={{ height: "auto", minHeight: "480px" }}>
                    <div className="frame-content-16_5">
                        {/* Header */}
                        <div id="16_6" className="stroke-wrapper-16_6">
                            <div className="Pixso-frame-16_6">
                                <div className="frame-content-16_6">
                                    <p id="16_7" className="Pixso-paragraph-16_7">
                                        {"创建新项目"}
                                    </p>
                                    <div
                                        id="16_8"
                                        className="Pixso-frame-16_8"
                                        onClick={handleCancel}
                                        style={{ cursor: "pointer" }}
                                        title="关闭"
                                    >
                                        <div className="frame-content-16_8">
                                            <div id="16_9" className="Pixso-vector-16_9"></div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                            <div className="stroke-16_6"></div>
                        </div>

                        {/* Fields Body */}
                        <div id="16_12" className="Pixso-frame-16_12">
                            <div className="frame-content-16_12">
                                <div id="16_13" className="stroke-wrapper-16_13" style={{ height: "auto" }}>
                                    <div className="Pixso-frame-16_13">
                                        <div className="frame-content-16_13">
                                            {/* Project Name Field */}
                                            <div id="16_14" className="Pixso-frame-16_14">
                                                <div className="frame-content-16_14">
                                                    <div id="16_15" className="Pixso-frame-16_15">
                                                        <div className="frame-content-16_15">
                                                            <p id="16_16" className="Pixso-paragraph-16_16">
                                                                {"项目名称"}
                                                            </p>
                                                            <p id="16_17" className="Pixso-paragraph-16_17">
                                                                {"*"}
                                                            </p>
                                                        </div>
                                                    </div>
                                                    <div id="16_18" className="stroke-wrapper-16_18">
                                                        <div className="Pixso-frame-16_18" style={{ padding: "0 12px", display: "flex", alignItems: "center" }}>
                                                            <input
                                                                type="text"
                                                                placeholder="请输入项目名称"
                                                                value={name}
                                                                onChange={(e) => setName(e.target.value)}
                                                                maxLength={100}
                                                                style={{
                                                                    width: "100%",
                                                                    background: "transparent",
                                                                    border: "none",
                                                                    color: "inherit",
                                                                    fontSize: "13px",
                                                                    outline: "none"
                                                                }}
                                                            />
                                                            <p id="16_20" className="Pixso-paragraph-16_20" style={{ marginLeft: "auto", position: "relative" }}>
                                                                {`${name.length} / 100`}
                                                            </p>
                                                        </div>
                                                        <div className="stroke-16_18"></div>
                                                    </div>
                                                </div>
                                            </div>

                                            {/* Cover upload */}
                                            <div id="16_26" className="Pixso-frame-16_26">
                                                <div className="frame-content-16_26">
                                                    <p id="16_27" className="Pixso-paragraph-16_27">
                                                        {"项目封面"}
                                                    </p>
                                                    <input
                                                        ref={fileInputRef}
                                                        type="file"
                                                        accept="image/jpeg,image/png,image/webp"
                                                        style={{ display: "none" }}
                                                        onChange={(e) => { handleFile(e.target.files?.[0]); e.target.value = ""; }}
                                                    />
                                                    <div id="16_28" className="stroke-wrapper-16_28">
                                                        <div
                                                            className="Pixso-frame-16_28"
                                                            style={{
                                                                cursor: "pointer",
                                                                position: "relative",
                                                                overflow: "hidden",
                                                                outline: dragOver ? "2px dashed #8b5cf6" : "none",
                                                            }}
                                                            onClick={() => fileInputRef.current?.click()}
                                                            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                                                            onDragLeave={() => setDragOver(false)}
                                                            onDrop={(e) => {
                                                                e.preventDefault();
                                                                setDragOver(false);
                                                                handleFile(e.dataTransfer.files?.[0]);
                                                            }}
                                                        >
                                                            {cover ? (
                                                                <>
                                                                    <img
                                                                        src={cover}
                                                                        alt="项目封面"
                                                                        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
                                                                    />
                                                                    <button
                                                                        onClick={(e) => { e.stopPropagation(); setCover(""); }}
                                                                        style={{
                                                                            position: "absolute", top: 8, right: 8, zIndex: 2,
                                                                            background: "rgba(0,0,0,0.55)", color: "#fff", border: "none",
                                                                            borderRadius: 6, padding: "2px 8px", fontSize: 12, cursor: "pointer"
                                                                        }}
                                                                    >
                                                                        {"移除"}
                                                                    </button>
                                                                </>
                                                            ) : (
                                                                <div className="frame-content-16_28">
                                                                    <div id="16_29" className="Pixso-frame-16_29">
                                                                        <div id="16_30" className="Pixso-group-16_30">
                                                                            <div id="16_33" className="Pixso-vector-16_33"></div>
                                                                        </div>
                                                                    </div>
                                                                    <p id="16_37" className="Pixso-paragraph-16_37">
                                                                        {"点击或拖拽上传项目封面"}
                                                                    </p>
                                                                    <p id="16_38" className="Pixso-paragraph-16_38">
                                                                        {"支持 JPG、PNG、WEBP 格式，最大 5MB"}
                                                                    </p>
                                                                </div>
                                                            )}
                                                        </div>
                                                        <div className="stroke-16_28"></div>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                    <div className="stroke-16_13"></div>
                                </div>

                                {/* Preferences Area — 画风 + 影片比例/生成模型/提示词方案（第243轮扩展） */}
                                <div id="16_39" className="Pixso-frame-16_39" style={{ height: "auto" }}>
                                    <div className="frame-content-16_39">
                                        <p id="16_40" className="Pixso-paragraph-16_40">
                                            {"作品画风"}
                                        </p>
                                        <div id="16_41" className="Pixso-frame-16_41" style={{ display: "flex", flexWrap: "wrap", gap: "16px" }}>
                                            <div className="frame-content-16_41" style={{ display: "flex", gap: "16px", width: "100%" }}>
                                                {/* Style Selector */}
                                                <div id="16_80" className="stroke-wrapper-16_80" style={{ flex: 1 }}>
                                                    <div className="Pixso-frame-16_80">
                                                        <div className="frame-content-16_80">
                                                            <p id="16_81" className="Pixso-paragraph-16_81">{"画风"}</p>
                                                            <p id="16_82" className="Pixso-paragraph-16_82">{"生成分镜画面的基础画风风格。"}</p>
                                                            <div id="16_83" className="stroke-wrapper-16_83">
                                                                <div className="Pixso-frame-16_83">
                                                                    <div className="frame-content-16_83">
                                                                        <select
                                                                            value={artStyleId}
                                                                            onChange={(e) => setArtStyleId(e.target.value)}
                                                                            style={{ background: "transparent", border: "none", color: "inherit", width: "100%", height: "100%", outline: "none", cursor: "pointer", appearance: "none" }}
                                                                        >
                                                                            {styleOptions.map((o) => (
                                                                                <option key={o.id} value={o.id}>{o.name}</option>
                                                                            ))}
                                                                        </select>
                                                                        <div id="16_85" className="Pixso-vector-16_85"></div>
                                                                    </div>
                                                                </div>
                                                                <div className="stroke-16_83"></div>
                                                            </div>
                                                            {selectedStyle?.image && (
                                                                <img
                                                                    src={selectedStyle.image}
                                                                    alt={`${selectedStyle.name} 参考图`}
                                                                    style={{ marginTop: 10, width: "100%", maxHeight: 160, objectFit: "cover", borderRadius: 8, border: "1px solid rgba(255,255,255,0.08)" }}
                                                                />
                                                            )}
                                                        </div>
                                                    </div>
                                                    <div className="stroke-16_80"></div>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                </div>

                                {/* ── 第243轮：影片比例 / 生成模型 / 提示词方案（新建即确定；进入项目后各界面仍可单独改） ── */}
                                <div style={{ display: "flex", flexDirection: "column", gap: 22, marginTop: 10, padding: "0 2px" }}>
                                    {/* 影片比例 */}
                                    <div>
                                        <p className="qiji-sec-title" style={secTitleStyle}>{"影片比例"}</p>
                                        <div style={{ display: "flex", gap: 12 }}>
                                            {ASPECT_CHOICES.map((a) => {
                                                const active = filmAspect === a.v;
                                                return (
                                                    <button
                                                        key={a.v}
                                                        type="button"
                                                        onClick={() => setFilmAspect(a.v)}
                                                        title="全程默认比例：故事板出图、视频生成与资产出图都按它（名称带比例的提示词模板会覆盖对应步骤；各界面仍可单独改）"
                                                        className={`qiji-aspect-chip${active ? " on" : ""}`}
                                                        style={{
                                                            flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 8,
                                                            padding: "12px 8px", borderRadius: 8, cursor: "pointer", fontSize: 12,
                                                        }}
                                                    >
                                                        <span style={{ height: 46, display: "flex", alignItems: "center" }}>
                                                            <span className="qiji-aspect-box" style={{ display: "block", width: a.w, height: a.h, borderRadius: 3 }} />
                                                        </span>
                                                        {a.label}
                                                    </button>
                                                );
                                            })}
                                        </div>
                                        {inferTplAspect && inferTplAspect !== filmAspect && (
                                            <p className="qiji-field-hint" style={hintStyle}>{`所选推理模板名称指定比例 ${inferTplAspect}——故事板/视频将按 ${inferTplAspect} 生成，其余步骤按 ${filmAspect}。`}</p>
                                        )}
                                    </div>

                                    {/* 生成模型 */}
                                    <div>
                                        <p className="qiji-sec-title" style={secTitleStyle}>{"生成模型"}</p>
                                        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                                            <ModelPicker cap="text" label="文本模型（剧集拆分 / 资产拆分 / 智能推理）" value={modelSel.text ?? ""} onChange={(id) => setModelSel((s) => ({ ...s, text: id }))} noPlaceholder />
                                            <ModelPicker cap="image" label="图像模型（资产出图 / 故事板）" value={modelSel.image ?? ""} onChange={(id) => setModelSel((s) => ({ ...s, image: id }))} noPlaceholder />
                                            <ModelPicker cap="video" label="视频模型（分镜成片）" value={modelSel.video ?? ""} onChange={(id) => setModelSel((s) => ({ ...s, video: id }))} noPlaceholder />
                                        </div>
                                        <p className="qiji-field-note" style={noteStyle}>{"未改动 = 自动使用当前第一个可用模型（与各界面默认一致）；进入项目后随时可换。"}</p>
                                    </div>

                                    {/* 提示词方案 */}
                                    <div>
                                        <p className="qiji-sec-title" style={secTitleStyle}>{"提示词方案"}</p>
                                        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                                            <label className="qiji-field-label" style={pickerLabelStyle}>
                                                {"剧集拆分方式"}
                                                <select value={episodeTplId} onChange={(e) => setEpisodeTplId(e.target.value)} className="qiji-field-select" style={pickerSelectStyle}>
                                                    {QUICK_SPLIT_CHOICES.map((c) => (
                                                        <option key={c.id} value={c.id} style={optStyle}>{c.label}</option>
                                                    ))}
                                                    {episodeTemplates.map((t) => (
                                                        <option key={t.id} value={t.id} style={optStyle}>{t.name}</option>
                                                    ))}
                                                </select>
                                            </label>
                                            <label className="qiji-field-label" style={pickerLabelStyle}>
                                                {"资产拆分模板"}
                                                <select value={assetTplId || defExtract?.id || ""} onChange={(e) => setAssetTplId(e.target.value)} className="qiji-field-select" style={pickerSelectStyle}>
                                                    {extractTemplates.length === 0 && (
                                                        <option value="" style={optStyle}>{"（连接管理端后可选，暂按默认）"}</option>
                                                    )}
                                                    {extractTemplates.map((t) => (
                                                        <option key={t.id} value={t.id} style={optStyle}>{t.name}</option>
                                                    ))}
                                                </select>
                                            </label>
                                            {assetTplAspect && (
                                                <p className="qiji-field-hint" style={{ ...hintStyle, marginTop: 0 }}>{`资产拆分模板名称指定比例 ${assetTplAspect}——资产出图将按 ${assetTplAspect}（其余步骤不受影响）。`}</p>
                                            )}
                                            <label className="qiji-check-label" style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 12 }} title="开启后：故事板与视频共用同一段「同源提示词」，推理走同源模板">
                                                <input type="checkbox" checked={sameSource} onChange={(e) => setSameSource(e.target.checked)} />
                                                {"图视同源（故事板与视频共用同一段提示词）"}
                                            </label>
                                            {sameSource ? (
                                                <TemplatePicker purpose="storyboard.unified" value={unifiedTplId} onChange={setUnifiedTplId} label="同源推理模板（多卡）" />
                                            ) : (
                                                <TemplatePicker purpose="storyboard.toVideoPrompt" value={inferTplId} onChange={setInferTplId} label="智能推理模板（多卡）" />
                                            )}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* Action Buttons */}
                        <div id="16_87" className="stroke-wrapper-16_87">
                            <div className="Pixso-frame-16_87">
                                <div className="frame-content-16_87">
                                    {/* 导入已有项目：不填表单、直接选 .Qiji 复制为新项目（靠左，与创建按钮组分开） */}
                                    <div className="stroke-wrapper-16_88" style={{ marginRight: "auto" }}>
                                        <div
                                            className="Pixso-frame-16_88"
                                            onClick={handleImport}
                                            style={{ cursor: "pointer" }}
                                            title="选择 .Qiji 项目文件，复制为一个全新项目导入（不影响原项目）"
                                        >
                                            <div className="frame-content-16_88">
                                                <p className="Pixso-paragraph-16_89">
                                                    {"导入已有项目 (.Qiji)"}
                                                </p>
                                            </div>
                                        </div>
                                        <div className="stroke-16_88" style={{ borderStyle: "dashed" }}></div>
                                    </div>
                                    <div id="16_88" className="stroke-wrapper-16_88">
                                        <div
                                            className="Pixso-frame-16_88"
                                            onClick={handleCancel}
                                            style={{ cursor: "pointer" }}
                                        >
                                            <div className="frame-content-16_88">
                                                <p id="16_89" className="Pixso-paragraph-16_89">
                                                    {"取消"}
                                                </p>
                                            </div>
                                        </div>
                                        <div className="stroke-16_88"></div>
                                    </div>
                                    {assetMode && (
                                        <div
                                            className="Pixso-frame-16_90"
                                            onClick={handleEnterAsset}
                                            style={{ cursor: "pointer" }}
                                        >
                                            <div className="frame-content-16_90">
                                                <p className="Pixso-paragraph-16_91">
                                                    {multiMode ? "进入资产模式" : "创建项目"}
                                                </p>
                                            </div>
                                        </div>
                                    )}
                                    {canvasMode && (
                                        <div
                                            id="16_90"
                                            className="Pixso-frame-16_90"
                                            onClick={handleEnterCanvas}
                                            style={{ cursor: "pointer" }}
                                        >
                                            <div className="frame-content-16_90">
                                                <p id="16_91" className="Pixso-paragraph-16_91">
                                                    {multiMode ? "进入画布模式" : "创建项目"}
                                                </p>
                                            </div>
                                        </div>
                                    )}
                                    {editorMode && (
                                        <div
                                            className="Pixso-frame-16_90"
                                            onClick={handleEnterEditor}
                                            style={{ cursor: "pointer" }}
                                        >
                                            <div className="frame-content-16_90">
                                                <p className="Pixso-paragraph-16_91">
                                                    {multiMode ? "进入实时剪辑" : "创建项目"}
                                                </p>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>
                            <div className="stroke-16_87"></div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default Frame164;
