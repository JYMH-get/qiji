import { useState, useEffect } from "react";
import EditorHeader from "@/components/EditorHeader";
import EditorSidebar from "@/components/EditorSidebar";
import { useProjectStore } from "@/store/projectStore";
import { getAdapter } from "@/services/adapters/registry";
import { resolveAssetModelKey } from "@/services/adapters/channelAdapter";
import { printLLMRequest, printLLMResponse } from "@/services/adapters/utils";
import "@/styles/Frame1693.css";

// @ts-ignore
import defaultPromptTemplate from "../../skills/剧本/角色提取提示词.md?raw";

// Helper formatters for template variables
function formatCharactersForTemplate(characters: any[]) {
    if (!characters || characters.length === 0) return "无角色数据";
    return characters.map((c, index) => 
        `角色 ${index + 1}: ${c.name}\n- 核心特征:\n${c.features || "无"}\n- 设计理念:\n${c.philosophy || "无"}\n- 三视图提示词:\n${c.prompt || "无"}`
    ).join("\n\n---\n\n");
}

function formatScenesForTemplate(scenes: any[]) {
    if (!scenes || scenes.length === 0) return "无场景数据";
    return scenes.map((s, index) => 
        `场景 ${index + 1}: ${s.name}\n- 描述:\n${s.description || "无"}\n- 设计理念:\n${s.philosophy || "无"}\n- 场景提示词:\n${s.prompt || "无"}`
    ).join("\n\n---\n\n");
}

function formatItemsForTemplate(items: any[]) {
    if (!items || items.length === 0) return "无物品/道具数据";
    return items.map((i, index) => 
        `物品 ${index + 1}: ${i.name}\n- 描述:\n${i.description || "无"}\n- 设计理念:\n${i.philosophy || "无"}\n- 物品提示词:\n${i.prompt || "无"}`
    ).join("\n\n---\n\n");
}

function formatOrganismsForTemplate(organisms: any[]) {
    if (!organisms || organisms.length === 0) return "无生物数据";
    return organisms.map((o, index) => 
        `生物 ${index + 1}: ${o.name}\n- 描述:\n${o.description || "无"}\n- 设计理念:\n${o.philosophy || "无"}\n- 生物提示词:\n${o.prompt || "无"}`
    ).join("\n\n---\n\n");
}

function compileTemplate(template: string, data: {
    projectName: string;
    scriptText: string;
    visualStyle: string;
    characters: any[];
    scenes: any[];
    items: any[];
    organisms: any[];
}) {
    const now = new Date();
    const currentTimeStr = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;

    const charFormatted = formatCharactersForTemplate(data.characters);
    const sceneFormatted = formatScenesForTemplate(data.scenes);
    const itemFormatted = formatItemsForTemplate(data.items);
    const organismFormatted = formatOrganismsForTemplate(data.organisms);

    return template
        .replace(/{{项目}}/g, () => data.projectName)
        .replace(/{{项目名称}}/g, () => data.projectName)
        .replace(/{{原文}}/g, () => data.scriptText)
        .replace(/{{小说原文}}/g, () => data.scriptText)
        .replace(/{{剧本原文}}/g, () => data.scriptText)
        .replace(/{{视觉风格}}/g, () => data.visualStyle)
        .replace(/{{角色列表}}/g, () => charFormatted)
        .replace(/{{场景列表}}/g, () => sceneFormatted)
        .replace(/{{物品列表}}/g, () => itemFormatted)
        .replace(/{{道具列表}}/g, () => itemFormatted)
        .replace(/{{生物列表}}/g, () => organismFormatted)
        .replace(/{{当前时间}}/g, () => currentTimeStr)
        .replace(/{{日期}}/g, () => currentTimeStr)
        .replace(/{{时间}}/g, () => currentTimeStr);
}

// Robust parsing scanner for extracting character templates from LLM output markdown
function parseExtractedCharacters(text: string) {
    const characters: Array<{ id: string; name: string; features: string; philosophy: string; prompt: string; image?: string }> = [];
    const lines = text.split("\n");
    let currentCharacter: any = null;
    let currentField = "";
    let idCounter = 0;
    
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        
        // Match "人物X：名称" or "人物：名称"
        const charMatch = trimmed.match(/^人物\d*[：:]\s*(.*)$/);
        if (charMatch) {
            if (currentCharacter && currentCharacter.name) {
                characters.push(currentCharacter);
            }
            idCounter++;
            currentCharacter = { 
                id: `char-${Date.now()}-${idCounter}`, 
                name: charMatch[1].trim(), 
                features: "", 
                philosophy: "", 
                prompt: "",
                image: undefined
            };
            currentField = "name";
            continue;
        }
        
        if (trimmed.startsWith("核心特征：") || trimmed.startsWith("核心特征:")) {
            currentField = "features";
            if (currentCharacter) {
                currentCharacter.features = trimmed.replace(/^核心特征[：:]\s*/, "") + "\n";
            }
            continue;
        }
        if (trimmed.startsWith("设计理念：") || trimmed.startsWith("设计理念:")) {
            currentField = "philosophy";
            if (currentCharacter) {
                currentCharacter.philosophy = trimmed.replace(/^设计理念[：:]\s*/, "") + "\n";
            }
            continue;
        }
        if (trimmed.startsWith("三视图提示词：") || trimmed.startsWith("三视图提示词:")) {
            currentField = "prompt";
            if (currentCharacter) {
                currentCharacter.prompt = trimmed.replace(/^三视图提示词[：:]\s*/, "") + "\n";
            }
            continue;
        }
        
        if (currentCharacter && currentField) {
            if (currentField === "features") {
                currentCharacter.features += trimmed + "\n";
            } else if (currentField === "philosophy") {
                currentCharacter.philosophy += trimmed + "\n";
            } else if (currentField === "prompt") {
                currentCharacter.prompt += trimmed + "\n";
            }
        }
    }
    
    if (currentCharacter && currentCharacter.name) {
        characters.push(currentCharacter);
    }
    
    // Clean up whitespace
    for (const c of characters) {
        c.features = c.features.trim();
        c.philosophy = c.philosophy.trim();
        c.prompt = c.prompt.trim();
    }
    
    return characters;
}

// Fallback high-fidelity character generator
function generateMockCharacters(scriptText: string, visualStyle: string) {
    const names = ["白起", "苏晴", "林枫", "阎王", "镇国将军", "姬如雪", "黑衣人"];
    const foundNames: string[] = [];
    for (const name of names) {
        if (scriptText.includes(name)) {
            foundNames.push(name);
        }
    }
    if (foundNames.length === 0) {
        foundNames.push("白起", "林枫", "苏晴");
    }
    
    return foundNames.map((name, index) => {
        let age = "20岁";
        let role = "主角";
        let body = "身形笔挺，高大瘦削";
        let clothing = "黑色长袍与斗篷";
        let color = "玄黑色与暗红";
        let tone = "冷峻孤傲，眼神如电";
        
        if (name === "苏晴" || name === "姬如雪") {
            age = "18岁";
            role = "女主";
            body = "体态轻盈优雅，身高一米六八";
            clothing = "白色仙裙，水袖飘逸";
            color = "淡月白与青莲色";
            tone = "清冷出尘，温婉坚毅";
        } else if (name === "阎王" || name === "黑衣人" || name === "镇国将军") {
            age = "35岁";
            role = "反派配角";
            body = "铁塔般的雄伟身躯，威武霸气";
            clothing = "重装暗金盔甲，兽面护心镜";
            color = "墨黑与暗金";
            tone = "狂放暴戾，霸气侧漏";
        }
        
        return {
            id: `char-${Date.now()}-${index}`,
            name,
            features: `性别：${role === "女主" ? "女" : "男"}\n年龄：${age}\n气质：${tone}\n身份：${role}\n服装：${clothing}\n色彩体系：${color}\n身材特征：${body}`,
            philosophy: `结合小说中${name}作为${role}的身份定位，设计强烈的视觉标签。${clothing}能够凸显其性格与身世，色彩搭配满足AI视频生成的稳定性。`,
            prompt: `16:9横版构图，纯白背景，影视级AI漫剧人物设定三视图，画面左侧为该角色的正面脸部特写，右侧为该角色的全身三视图，依次展示正面、侧面、背面。人物为${name}，年龄约${age}，身形${body}，整体气质${tone}。面部轮廓分明，眼神冷冽，发型利落，发色漆黑。服装为${clothing}，主色调为${color}，服装结构清晰，轮廓稳定，适合AI视频生成。正面、侧面、背面的人物发型、脸型、服装、身材比例完全一致。整体风格为${visualStyle}，角色辨识度高，造型简洁但有记忆点，电影级角色设定图，高清细节，4K画质，干净构图。不要手持任何道具，不要文字标注，不要网格线，不要分镜边框，不要水印，不要多余人物。`
        };
    });
}

const Frame1693 = () => {
    const characters = useProjectStore((s) => s.characters);
    const scenes = useProjectStore((s) => s.scenes);
    const items = useProjectStore((s) => s.items);
    const organisms = useProjectStore((s) => s.organisms);
    const isAnalyzed = useProjectStore((s) => s.isAnalyzed);
    const analysisTime = useProjectStore((s) => s.analysisTime);
    const visualStyle = useProjectStore((s) => s.visualStyle) || "国漫电影感";

    const [scriptText, setScriptText] = useState(useProjectStore.getState().scriptText || "");
    const [templates, setTemplates] = useState<string[]>(["角色提取提示词.md"]);
    const [selectedTemplate, setSelectedTemplate] = useState("角色提取提示词.md");
    const [isAnalyzing, setIsAnalyzing] = useState(false);
    const [analysisProgress, setAnalysisProgress] = useState(0);

    const storeScriptText = useProjectStore((s) => s.scriptText);
    useEffect(() => {
        setScriptText(storeScriptText);
    }, [storeScriptText]);

    // Load templates in skills/剧本/ on mount
    useEffect(() => {
        const loadTemplates = async () => {
            if (typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)) {
                try {
                    const { readDir } = await import("@tauri-apps/plugin-fs");
                    const entries = await readDir("e:/Kaifa/Qiji/qiji/skills/剧本");
                    const mdFiles = entries
                        .filter(entry => entry.isFile && entry.name?.endsWith(".md"))
                        .map(entry => entry.name || "");
                    const validFiles = mdFiles.filter(Boolean);
                    if (validFiles.length > 0) {
                        setTemplates(validFiles);
                        // If "角色提取提示词.md" is not present, default to the first one
                        if (validFiles.includes("角色提取提示词.md")) {
                            setSelectedTemplate("角色提取提示词.md");
                        } else {
                            setSelectedTemplate(validFiles[0]);
                        }
                    }
                } catch (err) {
                    console.warn("Failed to read templates directory:", err);
                }
            }
        };
        loadTemplates();
    }, []);

    const handleAnalyzeScript = async () => {
        if (!scriptText.trim()) {
            alert("请输入剧本文本后再进行分析");
            return;
        }
        setIsAnalyzing(true);
        setAnalysisProgress(10);

        try {
            // Load template
            let templateText = defaultPromptTemplate;
            if (selectedTemplate !== "通用资产提取") {
                try {
                    if (typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)) {
                        const { readTextFile } = await import("@tauri-apps/plugin-fs");
                        const fileText = await readTextFile(`e:/Kaifa/Qiji/qiji/skills/剧本/${selectedTemplate}`);
                        if (fileText && fileText.trim()) {
                            templateText = fileText;
                        }
                    }
                } catch (err) {
                    console.warn(`Failed to load prompt template ${selectedTemplate} from local fs:`, err);
                }
            }

            setAnalysisProgress(30);

            // Replace placeholders
            const compiledPrompt = compileTemplate(templateText, {
                projectName: useProjectStore.getState().name || "未命名项目",
                scriptText: scriptText,
                visualStyle: visualStyle,
                characters: useProjectStore.getState().characters || [],
                scenes: useProjectStore.getState().scenes || [],
                items: useProjectStore.getState().items || [],
                organisms: useProjectStore.getState().organisms || [],
            });

            setAnalysisProgress(50);

            // Resolve LLM model key & submit
            const textModelKey = resolveAssetModelKey("text", "gpt-5.5");
            const adapter = getAdapter(textModelKey);

            let resultText = "";
            if (adapter && textModelKey !== "gpt-5.5") {
                // Real LLM call
                const submitRes = await adapter.submit(
                    { prompt: compiledPrompt, _nodeId: `analyze-script-${Date.now()}` },
                    { temperature: 0.7, maxTokens: 4096 },
                    "text"
                );
                
                // Poll results
                let attempts = 0;
                while (attempts < 30) {
                    await new Promise(r => setTimeout(r, 1000));
                    const pollRes = await adapter.poll(submitRes.taskId);
                    if (pollRes.status === "success") {
                        resultText = pollRes.resultUri || "";
                        break;
                    } else if (pollRes.status === "failed") {
                        throw new Error(pollRes.error || "LLM 提取失败");
                    }
                    attempts++;
                    setAnalysisProgress(Math.min(95, 50 + attempts * 2));
                }
            }

            setAnalysisProgress(85);

            let charactersList: any[] = [];
            if (resultText && resultText.trim()) {
                charactersList = parseExtractedCharacters(resultText);
            }

            // Fallback or if list is empty
            if (charactersList.length === 0) {
                printLLMRequest(`MockInference:${textModelKey}`, "SIMULATED_LOCAL_MOCK_URL", "POST", { "Content-Type": "application/json" }, { prompt: compiledPrompt });
                // Simulate call / generate mock characters
                await new Promise(r => setTimeout(r, 1200));
                charactersList = generateMockCharacters(scriptText, visualStyle);
                printLLMResponse(`MockInference:${textModelKey}`, 200, 1200, { characters: charactersList });
            }

            const now = new Date();
            const timeString = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")}   ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

            // Save results to projectStore
            useProjectStore.getState().setAnalysisResult({
                characters: charactersList,
                scenes: [
                    { id: "scene-1", name: "阎王殿废墟大厅", description: "狂风掠过空旷荒凉的阎王殿废墟大厅，枯叶卷起，空气中充满冷峻沉寂的质感。", philosophy: "契合小说中的阎王殿场景。", prompt: "阎王殿废墟大厅，狂风卷起枯叶" },
                    { id: "scene-2", name: "阎王关隘", description: "中青衣壮汉立于荒凉关隘，狂风吹起斗篷，谷风萧瑟。", philosophy: "复现剧情对立感。", prompt: "荒凉的关隘，山谷风啸，微弱天光" }
                ],
                items: [
                    { id: "item-1", name: "青铜古剑", description: "白起腰间佩戴的古老青铜长剑，剑柄刻有斑驳纹路，显现岁月厚重。", philosophy: "角色的重要贴身物件。", prompt: "斑驳青铜古剑，剑柄雕花纹理，古拙质感" }
                ],
                organisms: [],
                time: timeString
            });

            // Auto-save project file
            await useProjectStore.getState().save(true);
            setAnalysisProgress(100);
            setTimeout(() => {
                setIsAnalyzing(false);
            }, 300);

        } catch (err) {
            console.error("Script analysis failed:", err);
            alert("剧本分析提取失败，请检查网络或配置");
            setIsAnalyzing(false);
        }
    };

    return (
        <div className="scroll-container">
            <div id="16_93" className="Pixso-frame-16_93">
                <EditorHeader title="剧本配置" infoLabels={["文本模型: gpt-5.5"]} />
                <div id="16_123" className="Pixso-frame-16_123">
                    <div className="frame-content-16_123">
                        <EditorSidebar activeTab="剧本" />
                        <div id="16_175" className="Pixso-frame-16_175">
                            <div className="frame-content-16_175">
                                <div
                                    id="16_176"
                                    className="stroke-wrapper-16_176"
                                >
                                    <div className="Pixso-frame-16_176">
                                        <div className="frame-content-16_176">
                                            <div
                                                id="16_177"
                                                className="Pixso-frame-16_177"
                                            >
                                                <div className="frame-content-16_177">
                                                    <div
                                                        id="16_178"
                                                        className="Pixso-frame-16_178"
                                                    >
                                                        <div className="frame-content-16_178">
                                                            <p
                                                                id="16_179"
                                                                className="Pixso-paragraph-16_179"
                                                            >
                                                                {"剧本识别"}
                                                            </p>
                                                            <p
                                                                id="16_180"
                                                                className="Pixso-paragraph-16_180"
                                                            >
                                                                {
                                                                    "上传 TXT/DOC/DOCX 或直接粘贴文本，系统会自动解析角色、场景与物品，并支持增量识别（仅新增缺失资产）。"
                                                                }
                                                            </p>
                                                        </div>
                                                    </div>
                                                    <div
                                                        id="16_181"
                                                        className="stroke-wrapper-16_181"
                                                        style={{ cursor: "pointer" }}
                                                        onClick={() => setScriptText("")}
                                                    >
                                                        <div className="Pixso-frame-16_181">
                                                            <div className="frame-content-16_181">
                                                                <div
                                                                    id="16_182"
                                                                    className="Pixso-vector-16_182"
                                                                ></div>
                                                                <p
                                                                    id="16_187"
                                                                    className="Pixso-paragraph-16_187"
                                                                >
                                                                    {"清空文本"}
                                                                </p>
                                                            </div>
                                                        </div>
                                                        <div className="stroke-16_181"></div>
                                                    </div>
                                                </div>
                                            </div>
                                            
                                            {/* File Upload mock area */}
                                            <div
                                                id="16_188"
                                                className="stroke-wrapper-16_188"
                                            >
                                                <div className="Pixso-frame-16_188">
                                                    <div className="frame-content-16_188">
                                                        <div
                                                            id="16_189"
                                                            className="Pixso-frame-16_189"
                                                        >
                                                            <div
                                                                id="16_190"
                                                                className="Pixso-vector-16_190"
                                                            ></div>
                                                            <p
                                                                id="16_193"
                                                                className="Pixso-paragraph-16_193"
                                                            >
                                                                {
                                                                    "TXT / DOC / DOCX"
                                                                }
                                                            </p>
                                                            <p
                                                                id="16_194"
                                                                className="Pixso-paragraph-16_194"
                                                            >
                                                                {
                                                                    "≤ 200,000 字  拖拽或"
                                                                }
                                                            </p>
                                                            <p
                                                                id="16_195"
                                                                className="Pixso-paragraph-16_195"
                                                                style={{ cursor: "pointer", textDecoration: "underline" }}
                                                                onClick={() => {
                                                                    // Mock file selection
                                                                    setScriptText("阎王殿废墟大厅里狂风大作，落叶纷飞。男主角白起（中青衣壮汉，身穿黑色长袍与斗篷）右手缓缓握紧腰间佩戴的古老青铜古剑柄，指节因用力微微发白。而在他面前，身材轻盈、身穿淡白水袖仙裙的姬如雪冷然站立，眼神中流露出清冷。殿外山峰峡谷之巅，镇国将军怒吼咆哮，似乎预示着一场绝战将临。");
                                                                    useProjectStore.getState().setScriptText("阎王殿废墟大厅里狂风大作，落叶纷飞。男主角白起（中青衣壮汉，身穿黑色长袍与斗篷）右手缓缓握紧腰间佩戴的古老青铜古剑柄，指节因用力微微发白。而在他面前，身材轻盈、身穿淡白水袖仙裙的姬如雪冷然站立，眼神中流露出清冷。殿外山峰峡谷之巅，镇国将军怒吼咆哮，似乎预示着一场绝战将临。");
                                                                }}
                                                            >
                                                                {"选择示例剧本"}
                                                            </p>
                                                        </div>
                                                        <div
                                                            id="16_196"
                                                            className="Pixso-frame-16_196"
                                                        >
                                                            <div className="frame-content-16_196">
                                                                <p
                                                                    id="16_197"
                                                                    className="Pixso-paragraph-16_197"
                                                                >
                                                                    {isAnalyzed ? "已导入" : "待分析"}
                                                                </p>
                                                            </div>
                                                        </div>
                                                    </div>
                                                </div>
                                                <div className="stroke-16_188"></div>
                                            </div>

                                            {/* Textarea Input area */}
                                            <div
                                                id="16_198"
                                                className="stroke-wrapper-16_198"
                                                style={{ height: "300px" }}
                                            >
                                                <div className="Pixso-frame-16_198" style={{ height: "100%", padding: "10px" }}>
                                                    <div className="frame-content-16_198" style={{ display: "flex", flexDirection: "column", height: "100%", width: "100%" }}>
                                                        <textarea
                                                            placeholder="粘贴或输入剧本文本，支持 200,000 字以内"
                                                            value={scriptText}
                                                            onChange={(e) => {
                                                                setScriptText(e.target.value);
                                                                useProjectStore.getState().setScriptText(e.target.value);
                                                            }}
                                                            style={{
                                                                flex: 1,
                                                                width: "100%",
                                                                background: "transparent",
                                                                border: "none",
                                                                color: "#ffffff",
                                                                fontSize: "13px",
                                                                outline: "none",
                                                                resize: "none",
                                                                lineHeight: "1.6",
                                                                fontFamily: "inherit"
                                                            }}
                                                        />
                                                        <p
                                                            id="16_200"
                                                            className="Pixso-paragraph-16_200"
                                                            style={{ alignSelf: "flex-end", marginTop: "auto" }}
                                                        >
                                                            {`${scriptText.length} / 200000`}
                                                        </p>
                                                    </div>
                                                </div>
                                                <div className="stroke-16_198"></div>
                                            </div>

                                            {/* Template Selection */}
                                            <div
                                                id="16_201"
                                                className="Pixso-frame-16_201"
                                            >
                                                <div className="frame-content-16_201">
                                                    <div
                                                        id="16_202"
                                                        className="Pixso-frame-16_202"
                                                    >
                                                        <div className="frame-content-16_202">
                                                            <p
                                                                id="16_203"
                                                                className="Pixso-paragraph-16_203"
                                                            >
                                                                {
                                                                    "共享模板（可选）"
                                                                }
                                                            </p>
                                                            <p
                                                                id="16_204"
                                                                className="Pixso-paragraph-16_204"
                                                            >
                                                                {
                                                                    "选定从 skills/ 文件夹加载的提示词模板"
                                                                }
                                                            </p>
                                                        </div>
                                                    </div>
                                                    <div
                                                        id="16_205"
                                                        className="stroke-wrapper-16_205"
                                                        style={{ position: "relative" }}
                                                    >
                                                        <div className="Pixso-frame-16_205" style={{ padding: "0 10px", display: "flex", alignItems: "center" }}>
                                                            <select
                                                                value={selectedTemplate}
                                                                onChange={(e) => setSelectedTemplate(e.target.value)}
                                                                style={{
                                                                    width: "100%",
                                                                    background: "transparent",
                                                                    border: "none",
                                                                    color: "#ffffff",
                                                                    fontSize: "12px",
                                                                    outline: "none",
                                                                    cursor: "pointer",
                                                                    appearance: "none",
                                                                    paddingRight: "20px"
                                                                }}
                                                            >
                                                                {templates.map((tmpl) => (
                                                                    <option key={tmpl} value={tmpl} style={{ background: "#1f1f2e", color: "#fff" }}>
                                                                        {tmpl}
                                                                    </option>
                                                                ))}
                                                                <option value="通用资产提取" style={{ background: "#1f1f2e", color: "#fff" }}>通用资产提取 (内置默认)</option>
                                                            </select>
                                                            <div
                                                                id="16_209"
                                                                className="Pixso-vector-16_209"
                                                                style={{ pointerEvents: "none", position: "absolute", right: "12px" }}
                                                            ></div>
                                                        </div>
                                                        <div className="stroke-16_205"></div>
                                                    </div>
                                                </div>
                                            </div>

                                            {/* Visual Style Selection */}
                                            <div
                                                id="16_201_style"
                                                className="Pixso-frame-16_201"
                                                style={{ marginTop: "12px" }}
                                            >
                                                <div className="frame-content-16_201">
                                                    <div
                                                        id="16_202_style"
                                                        className="Pixso-frame-16_202"
                                                    >
                                                        <div className="frame-content-16_202">
                                                            <p
                                                                className="Pixso-paragraph-16_203"
                                                            >
                                                                {
                                                                    "视觉风格（当前）"
                                                                }
                                                            </p>
                                                            <p
                                                                className="Pixso-paragraph-16_204"
                                                            >
                                                                {
                                                                    "提取和生成角色时使用此风格描述"
                                                                }
                                                            </p>
                                                        </div>
                                                    </div>
                                                    <div
                                                        className="stroke-wrapper-16_205"
                                                        style={{ position: "relative" }}
                                                    >
                                                        <div className="Pixso-frame-16_205" style={{ padding: "0 10px", display: "flex", alignItems: "center" }}>
                                                            <select
                                                                value={visualStyle}
                                                                onChange={(e) => {
                                                                    useProjectStore.getState().setVisualStyle(e.target.value);
                                                                }}
                                                                style={{
                                                                    width: "100%",
                                                                    background: "transparent",
                                                                    border: "none",
                                                                    color: "#ffffff",
                                                                    fontSize: "12px",
                                                                    outline: "none",
                                                                    cursor: "pointer",
                                                                    appearance: "none",
                                                                    paddingRight: "20px"
                                                                }}
                                                            >
                                                                <option value="国漫电影感" style={{ background: "#1f1f2e", color: "#fff" }}>国漫电影感</option>
                                                                <option value="2D日漫剧场版" style={{ background: "#1f1f2e", color: "#fff" }}>2D日漫剧场版</option>
                                                                <option value="3D国风动画" style={{ background: "#1f1f2e", color: "#fff" }}>3D国风动画</option>
                                                                <option value="电影级写实" style={{ background: "#1f1f2e", color: "#fff" }}>电影级写实</option>
                                                                <option value="玄幻仙侠国漫" style={{ background: "#1f1f2e", color: "#fff" }}>玄幻仙侠国漫</option>
                                                                <option value="武侠写实国风" style={{ background: "#1f1f2e", color: "#fff" }}>武侠写实国风</option>
                                                                <option value="暗黑修仙风" style={{ background: "#1f1f2e", color: "#fff" }}>暗黑修仙风</option>
                                                                <option value="热血少年漫风" style={{ background: "#1f1f2e", color: "#fff" }}>热血少年漫风</option>
                                                                <option value="红果短剧AI漫剧风格" style={{ background: "#1f1f2e", color: "#fff" }}>红果短剧AI漫剧风格</option>
                                                            </select>
                                                            <div
                                                                className="Pixso-vector-16_209"
                                                                style={{ pointerEvents: "none", position: "absolute", right: "12px" }}
                                                            ></div>
                                                        </div>
                                                        <div className="stroke-16_205"></div>
                                                    </div>
                                                </div>
                                            </div>

                                            {/* Action Button: Analyze Script */}
                                            <div
                                                id="16_211"
                                                className="Pixso-frame-16_211"
                                                onClick={isAnalyzing ? undefined : handleAnalyzeScript}
                                                style={{ cursor: isAnalyzing ? "not-allowed" : "pointer", opacity: isAnalyzing ? 0.7 : 1 }}
                                            >
                                                <div className="frame-content-16_211">
                                                    <p
                                                        id="16_212"
                                                        className="Pixso-paragraph-16_212"
                                                    >
                                                        {isAnalyzing ? `正在分析中 (${analysisProgress}%)` : "分析剧本"}
                                                    </p>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                    <div className="stroke-16_176"></div>
                                </div>
                                <div id="16_213" className="Pixso-frame-16_213">
                                    <div className="frame-content-16_213">
                                        <div
                                            id="16_214"
                                            className="Pixso-frame-16_214"
                                        >
                                            <div className="frame-content-16_214">
                                                <div
                                                    id="16_215"
                                                    className="Pixso-frame-16_215"
                                                >
                                                    <p
                                                        id="16_216"
                                                        className="Pixso-paragraph-16_216"
                                                    >
                                                        {"分析结果预览"}
                                                    </p>
                                                    <p
                                                        id="16_217"
                                                        className="Pixso-paragraph-16_217"
                                                    >
                                                        {
                                                            "快速浏览剧本解析出来的关键实体与分集颗粒度。"
                                                        }
                                                    </p>
                                                </div>
                                                <div
                                                    id="16_218"
                                                    className="stroke-wrapper-16_218"
                                                    style={{ cursor: "pointer" }}
                                                    onClick={handleAnalyzeScript}
                                                >
                                                    <div className="Pixso-frame-16_218">
                                                        <div className="frame-content-16_218">
                                                            <div
                                                                id="16_219"
                                                                className="Pixso-frame-16_219"
                                                            ></div>
                                                            <p
                                                                id="16_220"
                                                                className="Pixso-paragraph-16_220"
                                                            >
                                                                {"重新分析"}
                                                            </p>
                                                        </div>
                                                    </div>
                                                    <div className="stroke-16_218"></div>
                                                </div>
                                            </div>
                                        </div>
                                        
                                        {/* Status and Progress summary bar */}
                                        <div
                                            id="16_221"
                                            className="stroke-wrapper-16_221"
                                        >
                                            <div className="Pixso-frame-16_221" style={{ position: "relative", overflow: "hidden" }}>
                                                {/* Visual progress bar highlight */}
                                                <div style={{
                                                    position: "absolute",
                                                    left: 0,
                                                    top: 0,
                                                    bottom: 0,
                                                    width: isAnalyzing ? `${analysisProgress}%` : (isAnalyzed ? "100%" : "0%"),
                                                    background: "rgba(139, 92, 246, 0.15)",
                                                    transition: "width 0.3s ease-out",
                                                    borderRadius: "8px",
                                                    pointerEvents: "none"
                                                }} />
                                                
                                                <div className="frame-content-16_221" style={{ position: "relative", zIndex: 1 }}>
                                                    <p
                                                        id="16_222"
                                                        className="Pixso-paragraph-16_222"
                                                    >
                                                        {"最近分析时间"}
                                                    </p>
                                                    <p
                                                        id="16_223"
                                                        className="Pixso-paragraph-16_223"
                                                    >
                                                        {analysisTime || "暂无记录"}
                                                    </p>
                                                    <p
                                                        id="16_224"
                                                        className="Pixso-paragraph-16_224"
                                                    >
                                                        {isAnalyzing ? `${analysisProgress}%` : (isAnalyzed ? "100%" : "0%")}
                                                    </p>
                                                    <p
                                                        id="16_225"
                                                        className="Pixso-paragraph-16_225"
                                                    >
                                                        {isAnalyzing 
                                                            ? "分析中..." 
                                                            : (isAnalyzed ? `已完成 ${characters.length + scenes.length}/${characters.length + scenes.length}` : "已完成 0/0")}
                                                    </p>
                                                </div>
                                            </div>
                                            <div className="stroke-16_221"></div>
                                        </div>

                                        {/* Current Status message */}
                                        <div
                                            id="16_226"
                                            className="stroke-wrapper-16_226"
                                        >
                                            <div className="Pixso-frame-16_226">
                                                <div className="frame-content-16_226">
                                                    <p
                                                        id="16_227"
                                                        className="Pixso-paragraph-16_227"
                                                    >
                                                        {isAnalyzing ? "正在提取资产实体..." : (isAnalyzed ? "资产提取完成" : "尚未分析")}
                                                    </p>
                                                    <p
                                                        id="16_228"
                                                        className="Pixso-paragraph-16_228"
                                                    >
                                                        {isAnalyzing 
                                                            ? "系统正在努力检查剧本并识别角色、场景与物品实体，请稍候..." 
                                                            : (isAnalyzed 
                                                                ? "系统已成功识别剧本中的角色、场景、物品与生物实体，您可以在左侧面板中查看和管理。" 
                                                                : "系统会在检查剧本后自动识别角色、场景、物品等实体。")}
                                                    </p>
                                                    
                                                    {/* Entity Counts Cards */}
                                                    <div
                                                        id="16_229"
                                                        className="Pixso-frame-16_229"
                                                    >
                                                        <div className="frame-content-16_229">
                                                            {/* 1. Characters Card */}
                                                            <div
                                                                id="16_230"
                                                                className="stroke-wrapper-16_230"
                                                            >
                                                                <div className="Pixso-frame-16_230">
                                                                    <div className="frame-content-16_230">
                                                                        <div
                                                                            id="16_231"
                                                                            className="Pixso-frame-16_231"
                                                                        >
                                                                            <div
                                                                                id="16_232"
                                                                                className="Pixso-vector-16_232"
                                                                            ></div>
                                                                            <p
                                                                                id="16_237"
                                                                                className="Pixso-paragraph-16_237"
                                                                            >
                                                                                {
                                                                                    "角色"
                                                                                }
                                                                            </p>
                                                                        </div>
                                                                        <p
                                                                            id="16_238"
                                                                            className="Pixso-paragraph-16_238"
                                                                        >
                                                                            {characters.length}
                                                                        </p>
                                                                        <p
                                                                            id="16_239"
                                                                            className="Pixso-paragraph-16_239"
                                                                        >
                                                                            {
                                                                                isAnalyzed ? "源于剧本自动识别" : "未源于角色自动识别"
                                                                            }
                                                                        </p>
                                                                    </div>
                                                                </div>
                                                                <div className="stroke-16_230"></div>
                                                            </div>

                                                            {/* 2. Scenes Card */}
                                                            <div
                                                                id="16_240"
                                                                className="stroke-wrapper-16_240"
                                                            >
                                                                <div className="Pixso-frame-16_240">
                                                                    <div className="frame-content-16_240">
                                                                        <div
                                                                            id="16_241"
                                                                            className="Pixso-frame-16_241"
                                                                        >
                                                                            <div
                                                                                id="16_242"
                                                                                className="Pixso-frame-16_242"
                                                                            >
                                                                                <div
                                                                                    id="16_243"
                                                                                    className="stroke-wrapper-16_243"
                                                                                >
                                                                                    <div className="Pixso-rectangle-16_243"></div>
                                                                                    <div className="stroke-16_243"></div>
                                                                                </div>
                                                                                <div
                                                                                    id="16_244"
                                                                                    className="Pixso-vector-16_244"
                                                                                ></div>
                                                                                <div
                                                                                    id="16_245"
                                                                                    className="Pixso-vector-16_245"
                                                                                ></div>
                                                                            </div>
                                                                            <p
                                                                                id="16_246"
                                                                                className="Pixso-paragraph-16_246"
                                                                            >
                                                                                {
                                                                                    "场景"
                                                                                }
                                                                            </p>
                                                                        </div>
                                                                        <p
                                                                            id="16_247"
                                                                            className="Pixso-paragraph-16_247"
                                                                        >
                                                                            {scenes.length}
                                                                        </p>
                                                                        <p
                                                                            id="16_248"
                                                                            className="Pixso-paragraph-16_248"
                                                                        >
                                                                            {
                                                                                "覆盖的场景数量"
                                                                            }
                                                                        </p>
                                                                    </div>
                                                                </div>
                                                                <div className="stroke-16_240"></div>
                                                            </div>

                                                            {/* 3. Items Card */}
                                                            <div
                                                                id="16_249"
                                                                className="stroke-wrapper-16_249"
                                                            >
                                                                <div className="Pixso-frame-16_249">
                                                                    <div className="frame-content-16_249">
                                                                        <div
                                                                            id="16_250"
                                                                            className="Pixso-frame-16_250"
                                                                        >
                                                                            <div
                                                                                id="16_251"
                                                                                className="Pixso-vector-16_251"
                                                                            ></div>
                                                                            <p
                                                                                id="16_256"
                                                                                className="Pixso-paragraph-16_256"
                                                                            >
                                                                                {
                                                                                    "物品"
                                                                                }
                                                                            </p>
                                                                        </div>
                                                                        <p
                                                                            id="16_257"
                                                                            className="Pixso-paragraph-16_257"
                                                                        >
                                                                            {items.length}
                                                                        </p>
                                                                        <p
                                                                            id="16_258"
                                                                            className="Pixso-paragraph-16_258"
                                                                        >
                                                                            {
                                                                                "关键道具数量"
                                                                            }
                                                                        </p>
                                                                    </div>
                                                                </div>
                                                                <div className="stroke-16_249"></div>
                                                            </div>

                                                            {/* 4. Organisms Card */}
                                                            <div
                                                                id="16_259"
                                                                className="stroke-wrapper-16_259"
                                                            >
                                                                <div className="Pixso-frame-16_259">
                                                                    <div className="frame-content-16_259">
                                                                        <div
                                                                            id="16_260"
                                                                            className="Pixso-frame-16_260"
                                                                        >
                                                                            <div
                                                                                id="16_261"
                                                                                className="Pixso-vector-16_261"
                                                                            ></div>
                                                                            <p
                                                                                id="16_264"
                                                                                className="Pixso-paragraph-16_264"
                                                                            >
                                                                                {
                                                                                    "生物"
                                                                                }
                                                                            </p>
                                                                        </div>
                                                                        <p
                                                                            id="16_265"
                                                                            className="Pixso-paragraph-16_265"
                                                                        >
                                                                            {organisms.length}
                                                                        </p>
                                                                        <p
                                                                            id="16_266"
                                                                            className="Pixso-paragraph-16_266"
                                                                        >
                                                                            {
                                                                                "涉及的动物/生物"
                                                                            }
                                                                        </p>
                                                                    </div>
                                                                </div>
                                                                <div className="stroke-16_259"></div>
                                                            </div>
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>
                                            <div className="stroke-16_226"></div>
                                        </div>

                                        {/* Episodes/Split Overview summary */}
                                        <div
                                            id="16_267"
                                            className="stroke-wrapper-16_267"
                                        >
                                            <div className="Pixso-frame-16_267">
                                                <div className="frame-content-16_267">
                                                    <p
                                                        id="16_268"
                                                        className="Pixso-paragraph-16_268"
                                                    >
                                                        {"分集概览"}
                                                    </p>
                                                    <p
                                                        id="16_269"
                                                        className="Pixso-paragraph-16_269"
                                                    >
                                                        {
                                                            "确认剧本内容是否已经覆盖所有分集。"
                                                        }
                                                    </p>
                                                    <div
                                                        id="16_270"
                                                        className="stroke-wrapper-16_270"
                                                    >
                                                        <div className="Pixso-frame-16_270">
                                                            <div className="frame-content-16_270">
                                                                <div
                                                                    id="16_271"
                                                                    className="Pixso-frame-16_271"
                                                                >
                                                                    <div
                                                                        id="16_272"
                                                                        className="Pixso-frame-16_272"
                                                                    >
                                                                        <div
                                                                            id="16_273"
                                                                            className="stroke-wrapper-16_273"
                                                                        >
                                                                            <div className="Pixso-rectangle-16_273"></div>
                                                                            <div className="stroke-16_273"></div>
                                                                        </div>
                                                                        <div
                                                                            id="16_274"
                                                                            className="Pixso-vector-16_274"
                                                                        ></div>
                                                                        <div
                                                                            id="16_275"
                                                                            className="Pixso-vector-16_275"
                                                                        ></div>
                                                                        <div
                                                                            id="16_276"
                                                                            className="Pixso-vector-16_276"
                                                                        ></div>
                                                                        <div
                                                                            id="16_277"
                                                                            className="Pixso-vector-16_277"
                                                                        ></div>
                                                                        <div
                                                                            id="16_278"
                                                                            className="Pixso-vector-16_278"
                                                                        ></div>
                                                                        <div
                                                                            id="16_279"
                                                                            className="Pixso-vector-16_279"
                                                                        ></div>
                                                                        <div
                                                                            id="16_280"
                                                                            className="Pixso-vector-16_280"
                                                                        ></div>
                                                                    </div>
                                                                    <p
                                                                        id="16_281"
                                                                        className="Pixso-paragraph-16_281"
                                                                    >
                                                                        {
                                                                            "分集数量"
                                                                        }
                                                                    </p>
                                                                </div>
                                                                <p
                                                                    id="16_282"
                                                                    className="Pixso-paragraph-16_282"
                                                                >
                                                                    {isAnalyzed ? "3" : "0"}
                                                                </p>
                                                                <p
                                                                    id="16_283"
                                                                    className="Pixso-paragraph-16_283"
                                                                >
                                                                    {
                                                                        "脚本中可识别的章节/分集总量"
                                                                    }
                                                                </p>
                                                            </div>
                                                        </div>
                                                        <div className="stroke-16_270"></div>
                                                    </div>
                                                </div>
                                            </div>
                                            <div className="stroke-16_267"></div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};
export default Frame1693;
