import { useState, useEffect } from "react";
import { useNavigate } from "react-router";
import EditorHeader from "@/components/EditorHeader";
import EditorSidebar from "@/components/EditorSidebar";
import { useProjectStore } from "@/store/projectStore";
import { runPurpose } from "@/services/purposeRunner";
import "@/styles/Frame16285.css";

// 群像/阵营资产页：从「角色页」复制改造而来，读取 projectStore.crowds（G 编号），
// 与画布节点分组无关；出图复用 asset.character.image（群像属角色类多人立绘）。
const FrameGroup = () => {
    const navigate = useNavigate();
    const crowds = useProjectStore((s) => s.crowds);
    const visualStyle = useProjectStore((s) => s.visualStyle) || "国漫电影感";

    const [selectedCrowdId, setSelectedCrowdId] = useState<string | null>(null);
    const [searchQuery, setSearchQuery] = useState("");
    const [isGenerating, setIsGenerating] = useState<Record<string, boolean>>({});

    useEffect(() => {
        if (crowds.length > 0 && !selectedCrowdId) {
            setSelectedCrowdId(crowds[0].id);
        }
    }, [crowds, selectedCrowdId]);

    const activeCrowd = crowds.find((c) => c.id === selectedCrowdId) || null;

    const filteredCrowds = crowds.filter((c) =>
        c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        c.features.toLowerCase().includes(searchQuery.toLowerCase())
    );

    const handleGenerateImage = async (crowdId: string) => {
        const crowd = crowds.find((c) => c.id === crowdId);
        if (!crowd) return;

        setIsGenerating((prev) => ({ ...prev, [crowdId]: true }));

        try {
            const run = await runPurpose("asset.character.image", {
                prompt: crowd.prompt,
                params: { size: "1024x1024", quality: "standard" },
            });
            if (run.status === "no_model") throw new Error("未配置可用的图像模型，请先在「设置 → 模型」中选择后重试。");
            if (run.status === "failed") throw new Error(run.error || "生成失败");
            const generatedUri = run.resultUri;
            if (!generatedUri) throw new Error("模型返回为空，未生成图片。");

            useProjectStore.getState().updateCrowdImage(crowdId, generatedUri);
            await useProjectStore.getState().save(true);
        } catch (err) {
            console.error("Failed to generate crowd image:", err);
            alert(`生成群像失败：${err instanceof Error ? err.message : "未知错误"}`);
        } finally {
            setIsGenerating((prev) => ({ ...prev, [crowdId]: false }));
        }
    };

    return (
        <div className="scroll-container">
            <div id="16_285" className="Pixso-frame-16_285">
                <EditorHeader title="群像配置" infoLabels={["默认图片模型: Image-2", `画风: ${visualStyle}`, "默认比例: 16:9"]} />
                <div id="16_309" className="Pixso-frame-16_309">
                    <div className="frame-content-16_309">
                        <EditorSidebar activeTab="群像" />

                        {/* Middle panel: Crowd List */}
                        <div id="16_361" className="stroke-wrapper-16_361">
                            <div className="Pixso-frame-16_361">
                                <div className="frame-content-16_361">
                                    <div id="16_362" className="stroke-wrapper-16_362">
                                        <div className="Pixso-frame-16_362">
                                            <div className="frame-content-16_362">
                                                <p id="16_363" className="Pixso-paragraph-16_363">
                                                    {"群像列表"}
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
                                                placeholder="搜索群像名称..."
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

                                    {/* Crowd Cards list */}
                                    <div style={{ display: "flex", flexDirection: "column", gap: "10px", flex: 1, overflowY: "auto", paddingRight: "4px" }}>
                                        {crowds.length === 0 ? (
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
                                                <p>暂无群像数据，请先提取剧本资产</p>
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
                                            filteredCrowds.map((crowd) => {
                                                const isActive = crowd.id === selectedCrowdId;
                                                const subtitle = (crowd.features || "群像/阵营").replace(/\s+/g, " ").slice(0, 28);

                                                return (
                                                    <div
                                                        key={crowd.id}
                                                        className={`stroke-wrapper-16_377 ${isActive ? "active" : ""}`}
                                                        onClick={() => setSelectedCrowdId(crowd.id)}
                                                        style={{ cursor: "pointer" }}
                                                    >
                                                        <div className="Pixso-frame-16_377" style={{ background: isActive ? "rgba(139, 92, 246, 0.1)" : "" }}>
                                                            <div className="frame-content-16_377">
                                                                <div
                                                                    className="Pixso-frame-16_378"
                                                                    style={{
                                                                        backgroundImage: crowd.image ? `url(${crowd.image})` : "none",
                                                                        backgroundSize: "cover",
                                                                        backgroundPosition: "center",
                                                                        display: "flex",
                                                                        alignItems: "center",
                                                                        justifyContent: "center",
                                                                        backgroundRepeat: "no-repeat"
                                                                    }}
                                                                >
                                                                    {!crowd.image && (
                                                                        <div className="Pixso-vector-16_232" style={{ width: "16px", height: "16px", opacity: 0.3 }} />
                                                                    )}
                                                                </div>
                                                                <div className="Pixso-frame-16_379">
                                                                    <div className="frame-content-16_379">
                                                                        <p className="Pixso-paragraph-16_380">
                                                                            {crowd.name}
                                                                        </p>
                                                                        <p className="Pixso-paragraph-16_381">
                                                                            {subtitle}
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

                        {/* Right panel: Crowd Details */}
                        <div id="16_427" className="stroke-wrapper-16_427">
                            <div className="Pixso-frame-16_427">
                                {activeCrowd ? (
                                    <div className="frame-content-16_427" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
                                        <p id="16_428" className="Pixso-paragraph-16_428">
                                            {`${activeCrowd.name} 群像设定`}
                                        </p>

                                        {/* Group image view & generator button */}
                                        <div id="16_429" className="Pixso-frame-16_429" style={{ position: "relative" }}>
                                            <div className="frame-content-16_429" style={{ width: "100%", height: "100%" }}>
                                                <div
                                                    id="16_430"
                                                    className="Pixso-frame-16_430"
                                                    onClick={() => !isGenerating[activeCrowd.id] && handleGenerateImage(activeCrowd.id)}
                                                    style={{
                                                        width: "100%",
                                                        height: "100%",
                                                        backgroundImage: activeCrowd.image ? `url(${activeCrowd.image})` : "none",
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
                                                    {isGenerating[activeCrowd.id] ? (
                                                        <div style={{ color: "#a78bfa", fontSize: "13px", fontWeight: "bold" }}>
                                                            正在生成群像立绘...
                                                        </div>
                                                    ) : !activeCrowd.image ? (
                                                        <>
                                                            <div className="Pixso-vector-16_9" style={{ width: "24px", height: "24px", opacity: 0.5 }} />
                                                            <span style={{ fontSize: "11px", color: "rgba(255,255,255,0.4)" }}>
                                                                点击生成群像立绘
                                                            </span>
                                                        </>
                                                    ) : null}
                                                </div>
                                            </div>
                                        </div>

                                        {/* Detail attributes */}
                                        <div id="16_434" style={{ display: "flex", flexDirection: "column", gap: "12px", marginTop: "14px", flex: 1, overflowY: "auto", paddingRight: "4px" }}>
                                            {/* Design Philosophy / 群像识别点 */}
                                            <div id="16_461" className="Pixso-frame-16_461" style={{ height: "auto" }}>
                                                <div className="frame-content-16_461">
                                                    <div id="16_462" className="Pixso-frame-16_462">
                                                        <div className="frame-content-16_462">
                                                            <p id="16_463" className="Pixso-paragraph-16_463">
                                                                {"群像识别点"}
                                                            </p>
                                                        </div>
                                                    </div>
                                                    <p id="16_467" className="Pixso-paragraph-16_467" style={{ lineHeight: "1.5", fontSize: "11px", color: "rgba(255,255,255,0.7)" }}>
                                                        {activeCrowd.features || activeCrowd.philosophy}
                                                    </p>
                                                </div>
                                            </div>

                                            {/* Group prompt inputbox */}
                                            <div id="16_461_prompt" className="Pixso-frame-16_461" style={{ height: "auto", borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: "12px" }}>
                                                <div className="frame-content-16_461">
                                                    <p className="Pixso-paragraph-16_463" style={{ marginBottom: "6px" }}>
                                                        {"群像提示词"}
                                                    </p>
                                                    <textarea
                                                        value={activeCrowd.prompt}
                                                        onChange={(e) => {
                                                            const newPrompt = e.target.value;
                                                            useProjectStore.setState((s) => ({
                                                                crowds: s.crowds.map((c) => c.id === activeCrowd.id ? { ...c, prompt: newPrompt } : c),
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
                                                onClick={() => !isGenerating[activeCrowd.id] && handleGenerateImage(activeCrowd.id)}
                                                style={{
                                                    cursor: isGenerating[activeCrowd.id] ? "not-allowed" : "pointer",
                                                    opacity: isGenerating[activeCrowd.id] ? 0.7 : 1,
                                                    marginTop: "10px"
                                                }}
                                            >
                                                <div className="frame-content-16_468">
                                                    <div id="16_469" className="Pixso-frame-16_469">
                                                        <div className="frame-content-16_469">
                                                            <p id="16_470" className="Pixso-paragraph-16_470">
                                                                {isGenerating[activeCrowd.id] ? "生成中..." : "重新生成群像"}
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
                                        请选择一个群像以查看详细信息
                                    </div>
                                )}
                            </div>
                            <div className="stroke-16_427"></div>
                        </div>

                        {/* Variants right pane */}
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
                                                    {"状态变体"}
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

                                {/* Variants list */}
                                <div style={{ display: "flex", flexDirection: "column", gap: "10px", flex: 1, overflowY: "auto", paddingRight: "4px", marginTop: "10px", width: "100%" }}>
                                    <div id="16_502" className="Pixso-frame-16_502" style={{ height: "auto", width: "100%" }}>
                                        <div className="frame-content-16_502" style={{ display: "flex", flexDirection: "row", flexWrap: "wrap", gap: "16px", height: "auto", width: "100%" }}>
                                            {(activeCrowd?.variants ?? []).length === 0 ? (
                                                <div style={{ width: "100%", padding: "32px 16px", textAlign: "center", color: "var(--muted-foreground)", fontSize: "12px" }}>
                                                    {activeCrowd ? "暂无状态变体" : "请选择左侧群像"}
                                                </div>
                                            ) : (
                                                (activeCrowd?.variants ?? []).map((v) => (
                                                    <div key={v.id} className="stroke-wrapper-16_503">
                                                        <div className="Pixso-frame-16_503">
                                                            <div className="frame-content-16_503">
                                                                <div
                                                                    className="Pixso-frame-16_504"
                                                                    style={{
                                                                        backgroundImage: v.image ? `url(${v.image})` : "none",
                                                                        backgroundSize: "cover",
                                                                        backgroundPosition: "center",
                                                                        backgroundRepeat: "no-repeat"
                                                                    }}
                                                                >
                                                                    {!v.image && (
                                                                        <div className="Pixso-frame-16_505">
                                                                            <div className="stroke-wrapper-16_506">
                                                                                <div className="Pixso-rectangle-16_506"></div>
                                                                                <div className="stroke-16_506"></div>
                                                                            </div>
                                                                            <div className="Pixso-vector-16_507"></div>
                                                                            <div className="Pixso-vector-16_508"></div>
                                                                        </div>
                                                                    )}
                                                                    <div className="Pixso-frame-16_509">
                                                                        <div className="frame-content-16_509">
                                                                            <p className="Pixso-paragraph-16_510">{v.label}</p>
                                                                        </div>
                                                                    </div>
                                                                </div>
                                                                <div className="Pixso-frame-16_511">
                                                                    <div className="frame-content-16_511">
                                                                        <p className="Pixso-paragraph-16_512">{v.name}</p>
                                                                        <p className="Pixso-paragraph-16_513">{v.description}</p>
                                                                    </div>
                                                                </div>
                                                                <div className="stroke-wrapper-16_514" style={{ cursor: "pointer" }} onClick={() => activeCrowd && handleGenerateImage(activeCrowd.id)}>
                                                                    <div className="Pixso-frame-16_514">
                                                                        <div className="frame-content-16_514">
                                                                            <div className="Pixso-frame-16_516">
                                                                                <div className="frame-content-16_516">
                                                                                    <p className="Pixso-paragraph-16_517">{"生成"}</p>
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
                                                ))
                                            )}
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

export default FrameGroup;
