import { useState, useEffect } from "react";
import { useNavigate } from "react-router";
import EditorHeader from "@/components/EditorHeader";
import EditorSidebar from "@/components/EditorSidebar";
import { useProjectStore } from "@/store/projectStore";
import { resolveAssetModelKey } from "@/services/adapters/channelAdapter";
import { getAdapter } from "@/services/adapters/registry";
import { printLLMRequest, printLLMResponse } from "@/services/adapters/utils";
import "@/styles/Frame16285.css";

const Frame16285 = () => {
    const navigate = useNavigate();
    const characters = useProjectStore((s) => s.characters);
    const visualStyle = useProjectStore((s) => s.visualStyle) || "国漫电影感";

    const [selectedCharId, setSelectedCharId] = useState<string | null>(null);
    const [searchQuery, setSearchQuery] = useState("");
    const [isGenerating, setIsGenerating] = useState<Record<string, boolean>>({});

    // Set first character as active if none is selected
    useEffect(() => {
        if (characters.length > 0 && !selectedCharId) {
            setSelectedCharId(characters[0].id);
        }
    }, [characters, selectedCharId]);

    const activeChar = characters.find((c) => c.id === selectedCharId) || null;

    const filteredCharacters = characters.filter((c) =>
        c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        c.features.toLowerCase().includes(searchQuery.toLowerCase())
    );

    // Extract basic attributes from features text
    const getAttributeValue = (featuresText: string, label: string, fallback: string) => {
        const regex = new RegExp(`${label}[：:]\\s*(.*)`);
        const match = featuresText.match(regex);
        return match ? match[1].trim() : fallback;
    };

    const handleGenerateImage = async (charId: string) => {
        const char = characters.find((c) => c.id === charId);
        if (!char) return;

        setIsGenerating((prev) => ({ ...prev, [charId]: true }));

        try {
            const activeImageModel = resolveAssetModelKey("image", "sd-xl");
            const adapter = getAdapter(activeImageModel);

            let generatedUri = "";
            if (adapter && activeImageModel !== "sd-xl") {
                const submitRes = await adapter.submit(
                    { prompt: char.prompt, _nodeId: `gen-char-${charId}-${Date.now()}` },
                    { size: "1024x1024", quality: "standard" },
                    "image"
                );

                let attempts = 0;
                while (attempts < 30) {
                    await new Promise((r) => setTimeout(r, 1000));
                    const pollRes = await adapter.poll(submitRes.taskId);
                    if (pollRes.status === "success") {
                        generatedUri = pollRes.resultUri || "";
                        break;
                    } else if (pollRes.status === "failed") {
                        throw new Error(pollRes.error || "生成失败");
                    }
                    attempts++;
                }
            }

            if (!generatedUri) {
                printLLMRequest(`MockImageGen:${activeImageModel}`, "SIMULATED_LOCAL_MOCK_URL", "POST", { "Content-Type": "application/json" }, { prompt: char.prompt });
                // Fallback to high-quality Unsplash portraits
                await new Promise((r) => setTimeout(r, 1200));
                const mockPortraits = [
                    "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=600",
                    "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=600",
                    "https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?w=600",
                    "https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=600"
                ];
                const index = Math.floor(Math.random() * mockPortraits.length);
                generatedUri = mockPortraits[index];
                printLLMResponse(`MockImageGen:${activeImageModel}`, 200, 1200, { image: generatedUri });
            }

            // Update image state
            useProjectStore.getState().updateCharacterImage(charId, generatedUri);
            await useProjectStore.getState().save(true);
        } catch (err) {
            console.error("Failed to generate character image:", err);
            alert("生成形象失败，请检查网络或配置");
        } finally {
            setIsGenerating((prev) => ({ ...prev, [charId]: false }));
        }
    };

    return (
        <div className="scroll-container">
            <div id="16_285" className="Pixso-frame-16_285">
                <EditorHeader title="角色配置" infoLabels={["默认图片模型: Image-2", `画风: ${visualStyle}`, "默认角色比例: 9:16"]} />
                <div id="16_309" className="Pixso-frame-16_309">
                    <div className="frame-content-16_309">
                        <EditorSidebar activeTab="角色" />
                        
                        {/* Middle panel: Character List */}
                        <div id="16_361" className="stroke-wrapper-16_361">
                            <div className="Pixso-frame-16_361">
                                <div className="frame-content-16_361">
                                    <div id="16_362" className="stroke-wrapper-16_362">
                                        <div className="Pixso-frame-16_362">
                                            <div className="frame-content-16_362">
                                                <p id="16_363" className="Pixso-paragraph-16_363">
                                                    {"角色列表"}
                                                </p>
                                                <div id="16_364" className="Pixso-frame-16_364">
                                                    <p id="16_365" className="Pixso-paragraph-16_365">
                                                        {"一键生成"}
                                                    </p>
                                                    <p id="16_366" className="Pixso-paragraph-16_366">
                                                        {"管理"}
                                                    </p>
                                                </div>
                                                <div id="16_367" className="Pixso-frame-16_367">
                                                    <div className="frame-content-16_367">
                                                        <div id="16_368" className="Pixso-vector-16_368"></div>
                                                        <p id="16_371" className="Pixso-paragraph-16_371">
                                                            {"新建"}
                                                        </p>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                        <div className="stroke-16_362"></div>
                                    </div>
                                    
                                    {/* Search Input Box */}
                                    <div id="16_372" className="stroke-wrapper-16_372">
                                        <div className="Pixso-frame-16_372" style={{ padding: "0 10px", display: "flex", alignItems: "center" }}>
                                            <div id="16_373" className="Pixso-vector-16_373" style={{ marginRight: "8px" }}></div>
                                            <input
                                                type="text"
                                                placeholder="搜索名称..."
                                                value={searchQuery}
                                                onChange={(e) => setSearchQuery(e.target.value)}
                                                style={{
                                                    flex: 1,
                                                    background: "transparent",
                                                    border: "none",
                                                    color: "#ffffff",
                                                    fontSize: "12px",
                                                    outline: "none"
                                                }}
                                            />
                                        </div>
                                        <div className="stroke-16_372"></div>
                                    </div>

                                    {/* Character Cards list */}
                                    <div style={{ display: "flex", flexDirection: "column", gap: "10px", flex: 1, overflowY: "auto", paddingRight: "4px" }}>
                                        {characters.length === 0 ? (
                                            <div style={{
                                                padding: "40px 20px",
                                                textAlign: "center",
                                                color: "rgba(255,255,255,0.4)",
                                                fontSize: "13px",
                                                display: "flex",
                                                flexDirection: "column",
                                                alignItems: "center",
                                                gap: "12px"
                                            }}>
                                                <p>暂无角色数据，请先提取剧本资产</p>
                                                <button
                                                    onClick={() => navigate("/frame1693")}
                                                    style={{
                                                        padding: "6px 14px",
                                                        background: "#8b5cf6",
                                                        color: "#fff",
                                                        border: "none",
                                                        borderRadius: "6px",
                                                        cursor: "pointer",
                                                        fontSize: "12px"
                                                    }}
                                                >
                                                    前往剧本配置
                                                </button>
                                            </div>
                                        ) : (
                                            filteredCharacters.map((char) => {
                                                const isActive = char.id === selectedCharId;
                                                const displayAge = getAttributeValue(char.features, "年龄", "未定义");
                                                const displayGender = getAttributeValue(char.features, "性别", "男");
                                                const displayBody = getAttributeValue(char.features, "身材特征", "高大");

                                                return (
                                                    <div
                                                        key={char.id}
                                                        className={`stroke-wrapper-16_377 ${isActive ? "active" : ""}`}
                                                        onClick={() => setSelectedCharId(char.id)}
                                                        style={{ cursor: "pointer" }}
                                                    >
                                                        <div className="Pixso-frame-16_377" style={{ background: isActive ? "rgba(139, 92, 246, 0.1)" : "" }}>
                                                            <div className="frame-content-16_377">
                                                                <div
                                                                    className="Pixso-frame-16_378"
                                                                    style={{
                                                                        backgroundImage: char.image ? `url(${char.image})` : "none",
                                                                        backgroundSize: "cover",
                                                                        backgroundPosition: "center",
                                                                        display: "flex",
                                                                        alignItems: "center",
                                                                        justifyContent: "center",
                                                                        backgroundRepeat: "no-repeat"
                                                                    }}
                                                                >
                                                                    {!char.image && (
                                                                        <div className="Pixso-vector-16_232" style={{ width: "16px", height: "16px", opacity: 0.3 }} />
                                                                    )}
                                                                </div>
                                                                <div className="Pixso-frame-16_379">
                                                                    <div className="frame-content-16_379">
                                                                        <p className="Pixso-paragraph-16_380">
                                                                            {char.name}
                                                                        </p>
                                                                        <p className="Pixso-paragraph-16_381">
                                                                            {`${displayGender}，${displayAge}，${displayBody}`}
                                                                        </p>
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        </div>
                                                        <div className="stroke-16_377"></div>
                                                    </div>
                                                );
                                            })
                                        )}
                                    </div>
                                </div>
                            </div>
                            <div className="stroke-16_361"></div>
                        </div>

                        {/* Right panel: Character Details */}
                        <div id="16_427" className="stroke-wrapper-16_427">
                            <div className="Pixso-frame-16_427">
                                {activeChar ? (
                                    <div className="frame-content-16_427" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
                                        <p id="16_428" className="Pixso-paragraph-16_428">
                                            {`${activeChar.name} 基础形象`}
                                        </p>
                                        
                                        {/* Avatar view & generator button */}
                                        <div id="16_429" className="Pixso-frame-16_429" style={{ position: "relative" }}>
                                            <div className="frame-content-16_429" style={{ width: "100%", height: "100%" }}>
                                                <div
                                                    id="16_430"
                                                    className="Pixso-frame-16_430"
                                                    onClick={() => !isGenerating[activeChar.id] && handleGenerateImage(activeChar.id)}
                                                    style={{
                                                        width: "100%",
                                                        height: "100%",
                                                        backgroundImage: activeChar.image ? `url(${activeChar.image})` : "none",
                                                        backgroundSize: "cover",
                                                        backgroundPosition: "center",
                                                        backgroundRepeat: "no-repeat",
                                                        cursor: "pointer",
                                                        display: "flex",
                                                        flexDirection: "column",
                                                        alignItems: "center",
                                                        justifyContent: "center",
                                                        gap: "10px"
                                                    }}
                                                >
                                                    {isGenerating[activeChar.id] ? (
                                                        <div style={{ color: "#a78bfa", fontSize: "13px", fontWeight: "bold" }}>
                                                            正在生成三视图...
                                                        </div>
                                                    ) : !activeChar.image ? (
                                                        <>
                                                            <div className="Pixso-vector-16_9" style={{ width: "24px", height: "24px", opacity: 0.5 }} />
                                                            <span style={{ fontSize: "11px", color: "rgba(255,255,255,0.4)" }}>
                                                                点击生成三视图
                                                            </span>
                                                        </>
                                                    ) : null}
                                                </div>
                                            </div>
                                        </div>

                                        {/* Attributes list */}
                                        <div id="16_434" style={{ display: "flex", flexDirection: "column", gap: "12px", marginTop: "14px", flex: 1, overflowY: "auto", paddingRight: "4px" }}>
                                            <div className="frame-content-16_434" style={{ display: "flex", gap: "10px" }}>
                                                {/* Gender */}
                                                <div id="16_435" className="Pixso-frame-16_435" style={{ flex: 1 }}>
                                                    <div className="frame-content-16_435">
                                                        <p id="16_436" className="Pixso-paragraph-16_436">
                                                            {"性别"}
                                                        </p>
                                                        <div id="16_437" className="stroke-wrapper-16_437">
                                                            <div className="Pixso-frame-16_437">
                                                                <div className="frame-content-16_437">
                                                                    <p id="16_438" className="Pixso-paragraph-16_438">
                                                                        {getAttributeValue(activeChar.features, "性别", "男")}
                                                                    </p>
                                                                </div>
                                                            </div>
                                                            <div className="stroke-16_437"></div>
                                                        </div>
                                                    </div>
                                                </div>
                                                
                                                {/* Age */}
                                                <div id="16_439" className="Pixso-frame-16_439" style={{ flex: 1 }}>
                                                    <div className="frame-content-16_439">
                                                        <p id="16_440" className="Pixso-paragraph-16_440">
                                                            {"年龄"}
                                                        </p>
                                                        <div id="16_441" className="stroke-wrapper-16_441">
                                                            <div className="Pixso-frame-16_441">
                                                                <div className="frame-content-16_441">
                                                                    <p id="16_442" className="Pixso-paragraph-16_442">
                                                                        {getAttributeValue(activeChar.features, "年龄", "20岁")}
                                                                    </p>
                                                                </div>
                                                            </div>
                                                            <div className="stroke-16_441"></div>
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>

                                            {/* Audio/Voice Selector */}
                                            <div id="16_443" className="Pixso-frame-16_443">
                                                <div className="frame-content-16_443">
                                                    <p id="16_444" className="Pixso-paragraph-16_444">
                                                        {"音色"}
                                                    </p>
                                                    <div id="16_445" className="stroke-wrapper-16_445">
                                                        <div className="Pixso-frame-16_445">
                                                            <div className="frame-content-16_445">
                                                                <div id="16_446" className="Pixso-frame-16_446">
                                                                    <div id="16_447" className="Pixso-vector-16_447"></div>
                                                                    <div id="16_448" className="Pixso-vector-16_448"></div>
                                                                    <div id="16_449" className="stroke-wrapper-16_449">
                                                                        <div className="Pixso-rectangle-16_449"></div>
                                                                        <div className="stroke-16_449"></div>
                                                                    </div>
                                                                </div>
                                                                <p id="16_450" className="Pixso-paragraph-16_450">
                                                                    {"固定音色 (自动)"}
                                                                </p>
                                                            </div>
                                                        </div>
                                                        <div className="stroke-16_445"></div>
                                                    </div>
                                                </div>
                                            </div>

                                            {/* Design Philosophy Description */}
                                            <div id="16_461" className="Pixso-frame-16_461" style={{ height: "auto" }}>
                                                <div className="frame-content-16_461">
                                                    <div id="16_462" className="Pixso-frame-16_462">
                                                        <div className="frame-content-16_462">
                                                            <p id="16_463" className="Pixso-paragraph-16_463">
                                                                {"设计理念"}
                                                            </p>
                                                        </div>
                                                    </div>
                                                    <p id="16_467" className="Pixso-paragraph-16_467" style={{ lineHeight: "1.5", fontSize: "11px", color: "rgba(255,255,255,0.7)" }}>
                                                        {activeChar.philosophy}
                                                    </p>
                                                </div>
                                            </div>

                                            {/* Three-view Prompt inputbox */}
                                            <div id="16_461_prompt" className="Pixso-frame-16_461" style={{ height: "auto", borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: "12px" }}>
                                                <div className="frame-content-16_461">
                                                    <p className="Pixso-paragraph-16_463" style={{ marginBottom: "6px" }}>
                                                        {"三视图提示词"}
                                                    </p>
                                                    <textarea
                                                        value={activeChar.prompt}
                                                        onChange={(e) => {
                                                            const newPrompt = e.target.value;
                                                            useProjectStore.setState((s) => ({
                                                                characters: s.characters.map((c) => c.id === activeChar.id ? { ...c, prompt: newPrompt } : c),
                                                                isDirty: true
                                                            }));
                                                            useProjectStore.getState().scheduleAutoSave("canvas");
                                                        }}
                                                        style={{
                                                            width: "100%",
                                                            height: "80px",
                                                            background: "rgba(255,255,255,0.03)",
                                                            border: "1px solid rgba(255,255,255,0.08)",
                                                            borderRadius: "6px",
                                                            color: "#ffffff",
                                                            fontSize: "11px",
                                                            outline: "none",
                                                            resize: "none",
                                                            lineHeight: "1.4",
                                                            padding: "6px 8px"
                                                        }}
                                                    />
                                                </div>
                                            </div>

                                            {/* Image Gen Action Button */}
                                            <div
                                                id="16_468"
                                                className="Pixso-frame-16_468"
                                                onClick={() => !isGenerating[activeChar.id] && handleGenerateImage(activeChar.id)}
                                                style={{
                                                    cursor: isGenerating[activeChar.id] ? "not-allowed" : "pointer",
                                                    opacity: isGenerating[activeChar.id] ? 0.7 : 1,
                                                    marginTop: "10px"
                                                }}
                                            >
                                                <div className="frame-content-16_468">
                                                    <div id="16_469" className="Pixso-frame-16_469">
                                                        <div className="frame-content-16_469">
                                                            <p id="16_470" className="Pixso-paragraph-16_470">
                                                                {isGenerating[activeChar.id] ? "生成中..." : "重新生成形象"}
                                                            </p>
                                                        </div>
                                                    </div>
                                                    <div id="16_471" className="Pixso-frame-16_471"></div>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                ) : (
                                    <div style={{ display: "flex", flex: 1, alignItems: "center", justifyContent: "center", color: "rgba(255,255,255,0.4)" }}>
                                        请选择一个角色以查看详细信息
                                    </div>
                                )}
                            </div>
                            <div className="stroke-16_427"></div>
                        </div>

                        {/* Pose Styling Library right pane */}
                        <div id="16_472" className="Pixso-frame-16_472">
                            <div className="frame-content-16_472" style={{ display: "flex", flexDirection: "column", height: "100%", alignItems: "stretch" }}>
                                <div id="16_473" className="stroke-wrapper-16_473">
                                    <div className="Pixso-frame-16_473">
                                        <div className="frame-content-16_473">
                                            <div id="16_474" className="Pixso-frame-16_474">
                                                <div id="16_475" className="stroke-wrapper-16_475">
                                                    <div className="Pixso-frame-16_475"></div>
                                                    <div className="stroke-16_475"></div>
                                                </div>
                                                <p id="16_476" className="Pixso-paragraph-16_476">
                                                    {"造型预设"}
                                                </p>
                                            </div>
                                            <div id="16_477" className="Pixso-frame-16_477">
                                                <div id="16_478" className="Pixso-frame-16_478" style={{ cursor: "pointer" }}>
                                                    <div className="frame-content-16_478">
                                                        <div id="16_479" className="Pixso-vector-16_479"></div>
                                                        <p id="16_481" className="Pixso-paragraph-16_481">
                                                            {"一键生成"}
                                                        </p>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                    <div className="stroke-16_473"></div>
                                </div>
                                
                                {/* Poses presets list */}
                                <div style={{ display: "flex", flexDirection: "column", gap: "10px", flex: 1, overflowY: "auto", paddingRight: "4px", marginTop: "10px", width: "100%" }}>
                                    <div id="16_502" className="Pixso-frame-16_502" style={{ height: "auto", width: "100%" }}>
                                        <div className="frame-content-16_502" style={{ display: "flex", flexDirection: "row", flexWrap: "wrap", gap: "16px", height: "auto", width: "100%" }}>
                                            {/* Preset 1 */}
                                            <div id="16_503" className="stroke-wrapper-16_503">
                                                <div className="Pixso-frame-16_503">
                                                    <div className="frame-content-16_503">
                                                        <div
                                                            id="16_504"
                                                            className="Pixso-frame-16_504"
                                                            style={{
                                                                backgroundImage: activeChar?.image ? `url(${activeChar.image})` : "none",
                                                                backgroundSize: "cover",
                                                                backgroundPosition: "center",
                                                                backgroundRepeat: "no-repeat"
                                                            }}
                                                        >
                                                            {!activeChar?.image && (
                                                                <div id="16_505" className="Pixso-frame-16_505">
                                                                    <div id="16_506" className="stroke-wrapper-16_506">
                                                                        <div className="Pixso-rectangle-16_506"></div>
                                                                        <div className="stroke-16_506"></div>
                                                                    </div>
                                                                    <div id="16_507" className="Pixso-vector-16_507"></div>
                                                                    <div id="16_508" className="Pixso-vector-16_508"></div>
                                                                </div>
                                                            )}
                                                            <div id="16_509" className="Pixso-frame-16_509">
                                                                <div className="frame-content-16_509">
                                                                    <p id="16_510" className="Pixso-paragraph-16_510">
                                                                        {"默认"}
                                                                    </p>
                                                                </div>
                                                            </div>
                                                        </div>
                                                        <div id="16_511" className="Pixso-frame-16_511">
                                                            <div className="frame-content-16_511">
                                                                <p id="16_512" className="Pixso-paragraph-16_512">
                                                                    {activeChar ? `${activeChar.name}的形象1` : "角色形象1"}
                                                                </p>
                                                                <p id="16_513" className="Pixso-paragraph-16_513">
                                                                    {activeChar 
                                                                        ? `主要提取的长相，配以${getAttributeValue(activeChar.features, "服装", "经典服饰")}`
                                                                        : "经典造型三视图形象..."}
                                                                </p>
                                                            </div>
                                                        </div>
                                                        
                                                        {/* Generate Preset Image */}
                                                        <div id="16_514" className="stroke-wrapper-16_514" style={{ cursor: "pointer" }} onClick={() => activeChar && handleGenerateImage(activeChar.id)}>
                                                            <div className="Pixso-frame-16_514">
                                                                <div className="frame-content-16_514">
                                                                    <div id="16_516" className="Pixso-frame-16_516">
                                                                        <div className="frame-content-16_516">
                                                                            <p id="16_517" className="Pixso-paragraph-16_517">
                                                                                {"生成"}
                                                                            </p>
                                                                        </div>
                                                                    </div>
                                                                </div>
                                                            </div>
                                                            <div className="stroke-16_514"></div>
                                                        </div>
                                                    </div>
                                                </div>
                                                <div className="stroke-16_503"></div>
                                            </div>

                                            {/* Preset 2 */}
                                            <div id="16_519" className="stroke-wrapper-16_519">
                                                <div className="Pixso-frame-16_519">
                                                    <div className="frame-content-16_519">
                                                        <div
                                                            id="16_520"
                                                            className="Pixso-frame-16_520"
                                                            style={{
                                                                backgroundImage: activeChar?.image ? `url(${activeChar.image})` : "none",
                                                                backgroundSize: "cover",
                                                                backgroundPosition: "center",
                                                                backgroundRepeat: "no-repeat"
                                                            }}
                                                        >
                                                            {!activeChar?.image && (
                                                                <div id="16_521" className="Pixso-frame-16_521">
                                                                    <div id="16_522" className="stroke-wrapper-16_522">
                                                                        <div className="Pixso-rectangle-16_522"></div>
                                                                        <div className="stroke-16_522"></div>
                                                                    </div>
                                                                    <div id="16_523" className="Pixso-vector-16_523"></div>
                                                                    <div id="16_524" className="Pixso-vector-16_524"></div>
                                                                </div>
                                                            )}
                                                            <div id="16_525" className="Pixso-frame-16_525">
                                                                <div className="frame-content-16_525">
                                                                    <p id="16_526" className="Pixso-paragraph-16_526">
                                                                        {"战斗"}
                                                                    </p>
                                                                </div>
                                                            </div>
                                                        </div>
                                                        <div id="16_527" className="Pixso-frame-16_527">
                                                            <div className="frame-content-16_527">
                                                                <p id="16_528" className="Pixso-paragraph-16_528">
                                                                    {activeChar ? `${activeChar.name}的形象2` : "角色形象2"}
                                                                </p>
                                                                <p id="16_529" className="Pixso-paragraph-16_529">
                                                                    {activeChar 
                                                                        ? `${activeChar.name}的备用战斗/动作防装造型描述`
                                                                        : "备用战斗/动作防装造型描述..."}
                                                                </p>
                                                            </div>
                                                        </div>
                                                        <div id="16_530" className="stroke-wrapper-16_530" style={{ cursor: "pointer" }} onClick={() => activeChar && handleGenerateImage(activeChar.id)}>
                                                            <div className="Pixso-frame-16_530">
                                                                <div className="frame-content-16_530">
                                                                    <div id="16_532" className="Pixso-frame-16_532">
                                                                        <div className="frame-content-16_532">
                                                                            <p id="16_533" className="Pixso-paragraph-16_533">
                                                                                {"生成"}
                                                                            </p>
                                                                        </div>
                                                                    </div>
                                                                </div>
                                                            </div>
                                                            <div className="stroke-16_530"></div>
                                                        </div>
                                                    </div>
                                                </div>
                                                <div className="stroke-16_519"></div>
                                            </div>

                                            {/* Preset 3 */}
                                            <div id="16_535" className="stroke-wrapper-16_535">
                                                <div className="Pixso-frame-16_535">
                                                    <div className="frame-content-16_535">
                                                        <div
                                                            id="16_536"
                                                            className="Pixso-frame-16_536"
                                                            style={{
                                                                backgroundImage: activeChar?.image ? `url(${activeChar.image})` : "none",
                                                                backgroundSize: "cover",
                                                                backgroundPosition: "center",
                                                                backgroundRepeat: "no-repeat"
                                                            }}
                                                        >
                                                            {!activeChar?.image && (
                                                                <div id="16_537" className="Pixso-frame-16_537">
                                                                    <div id="16_538" className="stroke-wrapper-16_538">
                                                                        <div className="Pixso-rectangle-16_538"></div>
                                                                        <div className="stroke-16_538"></div>
                                                                    </div>
                                                                    <div id="16_539" className="Pixso-vector-16_539"></div>
                                                                    <div id="16_540" className="Pixso-vector-16_540"></div>
                                                                </div>
                                                            )}
                                                            <div id="16_541" className="Pixso-frame-16_541">
                                                                <div className="frame-content-16_541">
                                                                    <p id="16_542" className="Pixso-paragraph-16_542">
                                                                        {"日常"}
                                                                    </p>
                                                                </div>
                                                            </div>
                                                        </div>
                                                        <div id="16_543" className="Pixso-frame-16_543">
                                                            <div className="frame-content-16_543">
                                                                <p id="16_544" className="Pixso-paragraph-16_544">
                                                                    {activeChar ? `${activeChar.name}的形象3` : "角色形象3"}
                                                                </p>
                                                                <p id="16_545" className="Pixso-paragraph-16_545">
                                                                    {activeChar
                                                                        ? `${activeChar.name}的便服日常/备用场景造型描述`
                                                                        : "便服日常/备用场景造型描述..."}
                                                                </p>
                                                            </div>
                                                        </div>
                                                        <div id="16_546" className="stroke-wrapper-16_546" style={{ cursor: "pointer" }} onClick={() => activeChar && handleGenerateImage(activeChar.id)}>
                                                            <div className="Pixso-frame-16_546">
                                                                <div className="frame-content-16_546">
                                                                    <div id="16_547" className="Pixso-frame-16_547">
                                                                        <div className="frame-content-16_547">
                                                                            <p id="16_548" className="Pixso-paragraph-16_548">
                                                                                {"生成"}
                                                                            </p>
                                                                        </div>
                                                                    </div>
                                                                </div>
                                                            </div>
                                                            <div className="stroke-16_546"></div>
                                                        </div>
                                                    </div>
                                                </div>
                                                <div className="stroke-16_535"></div>
                                            </div>
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

export default Frame16285;
