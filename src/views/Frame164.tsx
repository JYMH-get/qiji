import { useNavigate } from "react-router";
import { useState } from "react";
import { useProjectStore } from "@/store/projectStore";
import { useSettingsStore } from "@/store/settingsStore";
import "@/styles/Frame164.css";

const Frame164 = () => {
    const navigate = useNavigate();
    const theme = useSettingsStore((s) => s.theme);

    // Form states
    const [name, setName] = useState("");
    const [desc, setDesc] = useState("");
    const [imgModel, setImgModel] = useState("NanoBanana2");
    const [videoModel, setVideoModel] = useState("Seedance 2.0 Pro");
    const [textModel, setTextModel] = useState("gpt-5.5");
    const [audioModel, setAudioModel] = useState("无");
    const [aspectRatio, setAspectRatio] = useState("16：9");
    const [artStyle, setArtStyle] = useState("3D国漫");

    const handleConfirm = async () => {
        const projName = name.trim() || "未命名项目";
        
        // 1. Initialize project store states
        useProjectStore.getState().newProject();
        useProjectStore.getState().setName(projName);
        
        // Map simplified artStyle to visual style definitions used in the prompt
        let computedStyle = "国漫电影感";
        if (artStyle === "3D国漫") {
            computedStyle = "3D国风动画";
        } else if (artStyle === "2D手绘") {
            computedStyle = "2D日漫剧场版";
        } else if (artStyle === "真人写实") {
            computedStyle = "电影级写实";
        }
        useProjectStore.getState().setVisualStyle(computedStyle);
        
        // Save initial project settings to settingsStore defaultModelConfigs if desired
        useSettingsStore.getState().setDefaultModelConfig("text", textModel);
        useSettingsStore.getState().setDefaultModelConfig("image", imgModel);
        
        // 2. Perform initial save to write project files and savePath
        await useProjectStore.getState().save(true);
        
        // 3. Switch view to editor workspace (Script category)
        navigate("/frame1693");
    };

    const handleCancel = () => {
        navigate("/");
    };

    return (
        <div className="scroll-container">
            <div id="16_4" className="Pixso-frame-16_4">
                <div id="16_5" className="Pixso-frame-16_5" style={{ minHeight: "860px" }}>
                    <div className="frame-content-16_5">
                        {/* Header */}
                        <div id="16_6" className="stroke-wrapper-16_6">
                            <div className="Pixso-frame-16_6">
                                <div className="frame-content-16_6">
                                    <p id="16_7" className="Pixso-paragraph-16_7">
                                        {"创建新项目"}
                                    </p>
                                    <div id="16_8" className="Pixso-frame-16_8">
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
                                <div id="16_13" className="stroke-wrapper-16_13">
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
                                                                    color: theme === "dark" ? "#ffffff" : "#1a1a2e",
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

                                            {/* Description Field */}
                                            <div id="16_21" className="Pixso-frame-16_21">
                                                <div className="frame-content-16_21">
                                                    <p id="16_22" className="Pixso-paragraph-16_22">
                                                        {"项目描述"}
                                                    </p>
                                                    <div id="16_23" className="stroke-wrapper-16_23">
                                                        <div className="Pixso-frame-16_23" style={{ padding: "8px 12px", display: "flex", flexDirection: "column" }}>
                                                            <textarea
                                                                placeholder="请输入项目描述（可选）"
                                                                value={desc}
                                                                onChange={(e) => setDesc(e.target.value)}
                                                                maxLength={2000}
                                                                style={{
                                                                    width: "100%",
                                                                    height: "60px",
                                                                    background: "transparent",
                                                                    border: "none",
                                                                    color: theme === "dark" ? "#ffffff" : "#1a1a2e",
                                                                    fontSize: "13px",
                                                                    resize: "none",
                                                                    outline: "none"
                                                                }}
                                                            />
                                                            <p id="16_25" className="Pixso-paragraph-16_25" style={{ marginLeft: "auto", marginTop: "auto" }}>
                                                                {`${desc.length} / 2000`}
                                                            </p>
                                                        </div>
                                                        <div className="stroke-16_23"></div>
                                                    </div>
                                                </div>
                                            </div>

                                            {/* Icon upload mockup */}
                                            <div id="16_26" className="Pixso-frame-16_26">
                                                <div className="frame-content-16_26">
                                                    <p id="16_27" className="Pixso-paragraph-16_27">
                                                        {"项目图标"}
                                                    </p>
                                                    <div id="16_28" className="stroke-wrapper-16_28">
                                                        <div className="Pixso-frame-16_28" style={{ cursor: "pointer" }}>
                                                            <div className="frame-content-16_28">
                                                                <div id="16_29" className="Pixso-frame-16_29">
                                                                    <div id="16_30" className="Pixso-group-16_30">
                                                                        <div id="16_33" className="Pixso-vector-16_33"></div>
                                                                    </div>
                                                                </div>
                                                                <p id="16_37" className="Pixso-paragraph-16_37">
                                                                    {"点击或拖拽上传项目图标"}
                                                                </p>
                                                                <p id="16_38" className="Pixso-paragraph-16_38">
                                                                    {"支持 JPG、PNG、WEBP 格式，最大 5MB"}
                                                                </p>
                                                            </div>
                                                        </div>
                                                        <div className="stroke-16_28"></div>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                    <div className="stroke-16_13"></div>
                                </div>

                                {/* Preferences Area */}
                                <div id="16_39" className="Pixso-frame-16_39">
                                    <div className="frame-content-16_39">
                                        <p id="16_40" className="Pixso-paragraph-16_40">
                                            {"全局生成偏好"}
                                        </p>
                                        <div id="16_41" className="Pixso-frame-16_41" style={{ display: "flex", flexWrap: "wrap", gap: "16px" }}>
                                            <div className="frame-content-16_41" style={{ display: "flex", gap: "16px", width: "100%" }}>
                                                {/* Image Model Selector */}
                                                <div id="16_43" className="stroke-wrapper-16_43" style={{ flex: 1 }}>
                                                    <div className="Pixso-frame-16_43">
                                                        <div className="frame-content-16_43">
                                                            <p id="16_44" className="Pixso-paragraph-16_44">{"默认图片模型"}</p>
                                                            <p id="16_45" className="Pixso-paragraph-16_45">{"用于文生图、图生图的偏好模型。"}</p>
                                                            <div id="16_46" className="stroke-wrapper-16_46">
                                                                <div className="Pixso-frame-16_46">
                                                                    <div className="frame-content-16_46">
                                                                        <select
                                                                            value={imgModel}
                                                                            onChange={(e) => setImgModel(e.target.value)}
                                                                            style={{ background: "transparent", border: "none", color: "inherit", width: "100%", height: "100%", outline: "none", cursor: "pointer", appearance: "none" }}
                                                                        >
                                                                            <option value="NanoBanana2">NanoBanana2</option>
                                                                            <option value="SD-XL">SD-XL 1.0</option>
                                                                            <option value="Midjourney-v6">Midjourney v6</option>
                                                                        </select>
                                                                        <div id="16_48" className="Pixso-vector-16_48"></div>
                                                                    </div>
                                                                </div>
                                                                <div className="stroke-16_46"></div>
                                                            </div>
                                                        </div>
                                                    </div>
                                                    <div className="stroke-16_43"></div>
                                                </div>

                                                {/* Video Model Selector */}
                                                <div id="16_50" className="stroke-wrapper-16_50" style={{ flex: 1 }}>
                                                    <div className="Pixso-frame-16_50">
                                                        <div className="frame-content-16_50">
                                                            <p id="16_51" className="Pixso-paragraph-16_51">{"默认视频模型"}</p>
                                                            <p id="16_52" className="Pixso-paragraph-16_52">{"自动生成分镜视频的默认模型。"}</p>
                                                            <div id="16_53" className="stroke-wrapper-16_53">
                                                                <div className="Pixso-frame-16_53">
                                                                    <div className="frame-content-16_53">
                                                                        <select
                                                                            value={videoModel}
                                                                            onChange={(e) => setVideoModel(e.target.value)}
                                                                            style={{ background: "transparent", border: "none", color: "inherit", width: "100%", height: "100%", outline: "none", cursor: "pointer", appearance: "none" }}
                                                                        >
                                                                            <option value="Seedance 2.0 Pro">Seedance 2.0 Pro</option>
                                                                            <option value="Sora">Sora Turbo</option>
                                                                            <option value="Luma-Dream">Luma Dream Machine</option>
                                                                        </select>
                                                                        <div id="16_55" className="Pixso-vector-16_55"></div>
                                                                    </div>
                                                                </div>
                                                                <div className="stroke-16_53"></div>
                                                            </div>
                                                        </div>
                                                    </div>
                                                    <div className="stroke-16_50"></div>
                                                </div>
                                            </div>

                                            <div className="frame-content-16_41" style={{ display: "flex", gap: "16px", width: "100%" }}>
                                                {/* Inference Model Selector */}
                                                <div id="16_58" className="stroke-wrapper-16_58" style={{ flex: 1 }}>
                                                    <div className="Pixso-frame-16_58">
                                                        <div className="frame-content-16_58">
                                                            <p id="16_59" className="Pixso-paragraph-16_59">{"默认推理模型"}</p>
                                                            <p id="16_60" className="Pixso-paragraph-16_60">{"用于剧本分析及资产分析的模型。"}</p>
                                                            <div id="16_61" className="stroke-wrapper-16_61">
                                                                <div className="Pixso-frame-16_61">
                                                                    <div className="frame-content-16_61">
                                                                        <select
                                                                            value={textModel}
                                                                            onChange={(e) => setTextModel(e.target.value)}
                                                                            style={{ background: "transparent", border: "none", color: "inherit", width: "100%", height: "100%", outline: "none", cursor: "pointer", appearance: "none" }}
                                                                        >
                                                                            <option value="gpt-5.5">gpt-5.5</option>
                                                                            <option value="gpt-4o">gpt-4o</option>
                                                                            <option value="claude-3.5-sonnet">claude-3.5-sonnet</option>
                                                                        </select>
                                                                        <div id="16_63" className="Pixso-vector-16_63"></div>
                                                                    </div>
                                                                </div>
                                                                <div className="stroke-16_61"></div>
                                                            </div>
                                                        </div>
                                                    </div>
                                                    <div className="stroke-16_58"></div>
                                                </div>

                                                {/* Audio Model Selector */}
                                                <div id="16_65" className="stroke-wrapper-16_65" style={{ flex: 1 }}>
                                                    <div className="Pixso-frame-16_65">
                                                        <div className="frame-content-16_65">
                                                            <p id="16_66" className="Pixso-paragraph-16_66">{"默认音频模型"}</p>
                                                            <p id="16_67" className="Pixso-paragraph-16_67">{"用于配音和音效生成的默认模型。"}</p>
                                                            <div id="16_68" className="stroke-wrapper-16_68">
                                                                <div className="Pixso-frame-16_68">
                                                                    <div className="frame-content-16_68">
                                                                        <select
                                                                            value={audioModel}
                                                                            onChange={(e) => setAudioModel(e.target.value)}
                                                                            style={{ background: "transparent", border: "none", color: "inherit", width: "100%", height: "100%", outline: "none", cursor: "pointer", appearance: "none" }}
                                                                        >
                                                                            <option value="无">无</option>
                                                                            <option value="ElevenLabs">ElevenLabs v2</option>
                                                                            <option value="ChatTTS">ChatTTS</option>
                                                                        </select>
                                                                        <div id="16_70" className="Pixso-vector-16_70"></div>
                                                                    </div>
                                                                </div>
                                                                <div className="stroke-16_68"></div>
                                                            </div>
                                                        </div>
                                                    </div>
                                                    <div className="stroke-16_65"></div>
                                                </div>
                                            </div>

                                            <div className="frame-content-16_41" style={{ display: "flex", gap: "16px", width: "100%" }}>
                                                {/* Ratio Selector */}
                                                <div id="16_73" className="stroke-wrapper-16_73" style={{ flex: 1 }}>
                                                    <div className="Pixso-frame-16_73">
                                                        <div className="frame-content-16_73">
                                                            <p id="16_74" className="Pixso-paragraph-16_74">{"默认比例"}</p>
                                                            <p id="16_75" className="Pixso-paragraph-16_75">{"默认视频生成的高宽比例。"}</p>
                                                            <div id="16_76" className="stroke-wrapper-16_76">
                                                                <div className="Pixso-frame-16_76">
                                                                    <div className="frame-content-16_76">
                                                                        <select
                                                                            value={aspectRatio}
                                                                            onChange={(e) => setAspectRatio(e.target.value)}
                                                                            style={{ background: "transparent", border: "none", color: "inherit", width: "100%", height: "100%", outline: "none", cursor: "pointer", appearance: "none" }}
                                                                        >
                                                                            <option value="16：9">16 : 9 (横屏电影)</option>
                                                                            <option value="9：16">9 : 16 (竖屏短剧)</option>
                                                                            <option value="1：1">1 : 1 (正方形)</option>
                                                                        </select>
                                                                        <div id="16_78" className="Pixso-vector-16_78"></div>
                                                                    </div>
                                                                </div>
                                                                <div className="stroke-16_76"></div>
                                                            </div>
                                                        </div>
                                                    </div>
                                                    <div className="stroke-16_73"></div>
                                                </div>

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
                                                                            value={artStyle}
                                                                            onChange={(e) => setArtStyle(e.target.value)}
                                                                            style={{ background: "transparent", border: "none", color: "inherit", width: "100%", height: "100%", outline: "none", cursor: "pointer", appearance: "none" }}
                                                                        >
                                                                            <option value="3D国漫">3D国漫 (动漫半写实)</option>
                                                                            <option value="2D手绘">2D手绘 (二次元日系)</option>
                                                                            <option value="真人写实">真人写实 (电影级大片)</option>
                                                                        </select>
                                                                        <div id="16_85" className="Pixso-vector-16_85"></div>
                                                                    </div>
                                                                </div>
                                                                <div className="stroke-16_83"></div>
                                                            </div>
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
                                        id="16_90"
                                        className="Pixso-frame-16_90"
                                        onClick={handleConfirm}
                                        style={{ cursor: "pointer" }}
                                    >
                                        <div className="frame-content-16_90">
                                            <p id="16_91" className="Pixso-paragraph-16_91">
                                                {"确认创建"}
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
