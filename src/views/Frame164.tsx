import { useNavigate } from "react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useProjectStore } from "@/store/projectStore";
import { useCatalogStore } from "@/store/catalogStore";
import "@/styles/Frame164.css";

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

    const handleCancel = () => {
        navigate("/");
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

                                {/* Preferences Area — 仅保留画风 */}
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
                                                            <p id="16_81" className="Pixso-paragraph-16_81">{"默认画风"}</p>
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
                            </div>
                        </div>

                        {/* Action Buttons */}
                        <div id="16_87" className="stroke-wrapper-16_87">
                            <div className="Pixso-frame-16_87">
                                <div className="frame-content-16_87">
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
                                    <div
                                        className="Pixso-frame-16_90"
                                        onClick={handleEnterAsset}
                                        style={{ cursor: "pointer" }}
                                    >
                                        <div className="frame-content-16_90">
                                            <p className="Pixso-paragraph-16_91">
                                                {"进入资产模式"}
                                            </p>
                                        </div>
                                    </div>
                                    <div
                                        id="16_90"
                                        className="Pixso-frame-16_90"
                                        onClick={handleEnterCanvas}
                                        style={{ cursor: "pointer" }}
                                    >
                                        <div className="frame-content-16_90">
                                            <p id="16_91" className="Pixso-paragraph-16_91">
                                                {"进入画布模式"}
                                            </p>
                                        </div>
                                    </div>
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
