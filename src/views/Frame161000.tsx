import { useState, useEffect } from "react";
import { useNavigate } from "react-router";
import EditorHeader from "@/components/EditorHeader";
import EditorSidebar from "@/components/EditorSidebar";
import { useProjectStore } from "@/store/projectStore";
import { resolveAssetModelKey } from "@/services/adapters/channelAdapter";
import { getAdapter } from "@/services/adapters/registry";
import { printLLMRequest, printLLMResponse } from "@/services/adapters/utils";
import "@/styles/Frame16285.css"; // Reuse character configuration styles for identical layout

const Frame161000 = () => {
    const navigate = useNavigate();
    const items = useProjectStore((s) => s.items);
    const visualStyle = useProjectStore((s) => s.visualStyle) || "国漫电影感";

    const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
    const [searchQuery, setSearchQuery] = useState("");
    const [isGenerating, setIsGenerating] = useState<Record<string, boolean>>({});

    // Set first item as active if none is selected
    useEffect(() => {
        if (items.length > 0 && !selectedItemId) {
            setSelectedItemId(items[0].id);
        }
    }, [items, selectedItemId]);

    const activeItem = items.find((i) => i.id === selectedItemId) || null;

    const filteredItems = items.filter((i) =>
        i.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        i.description.toLowerCase().includes(searchQuery.toLowerCase())
    );

    // Extract basic attributes from description text
    const getAttributeValue = (descText: string, label: string, fallback: string) => {
        const regex = new RegExp(`${label}[：:]\\s*(.*)`);
        const match = descText?.match(regex);
        return match ? match[1].trim() : fallback;
    };

    const updateAttribute = (label: string, value: string) => {
        if (!activeItem) return;
        const desc = activeItem.description || "";
        const regex = new RegExp(`${label}[：:][^\n]*`);
        let newDesc = desc;
        if (desc.match(regex)) {
            newDesc = desc.replace(regex, `${label}：${value}`);
        } else {
            newDesc = `${label}：${value}\n${desc}`;
        }
        useProjectStore.setState((s) => ({
            items: s.items.map((it) => it.id === activeItem.id ? { ...it, description: newDesc } : it),
            isDirty: true
        }));
        useProjectStore.getState().scheduleAutoSave("canvas");
    };

    const handleAddItem = () => {
        const newId = `item-${Date.now()}`;
        const newItem = {
            id: newId,
            name: `新道具 ${items.length + 1}`,
            description: "材质：金属\n尺寸：常规\n光泽：金属光泽\n描述：这里是道具的详细描述",
            philosophy: "体现道具的独特工艺与历史感，贴合剧本整体基调。",
            prompt: `16:9构图，纯白背景，道具设计图，新道具，精细雕琢，细节丰富，风格为${visualStyle}。`
        };
        useProjectStore.setState((s) => ({
            items: [...s.items, newItem],
            isDirty: true
        }));
        setSelectedItemId(newId);
        useProjectStore.getState().scheduleAutoSave("canvas");
    };

    const handleDeleteItem = (itemId: string) => {
        useProjectStore.setState((s) => ({
            items: s.items.filter((it) => it.id !== itemId),
            isDirty: true
        }));
        if (selectedItemId === itemId) {
            setSelectedItemId(null);
        }
        useProjectStore.getState().scheduleAutoSave("canvas");
    };

    const handleGenerateImage = async (itemId: string) => {
        const item = items.find((i) => i.id === itemId);
        if (!item) return;

        setIsGenerating((prev) => ({ ...prev, [itemId]: true }));

        try {
            const activeImageModel = resolveAssetModelKey("image", "sd-xl");
            const adapter = getAdapter(activeImageModel);

            let generatedUri = "";
            if (adapter && activeImageModel !== "sd-xl") {
                const submitRes = await adapter.submit(
                    { prompt: item.prompt, _nodeId: `gen-item-${itemId}-${Date.now()}` },
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
                printLLMRequest(`MockImageGen:${activeImageModel}`, "SIMULATED_LOCAL_MOCK_URL", "POST", { "Content-Type": "application/json" }, { prompt: item.prompt });
                // Fallback to high-quality Unsplash item/prop style images
                await new Promise((r) => setTimeout(r, 1200));
                const mockItems = [
                    "https://images.unsplash.com/photo-1584622650111-993a426fbf0a?w=600", // antique key
                    "https://images.unsplash.com/photo-1513542789411-b6a5d4f31634?w=600", // hourglass
                    "https://images.unsplash.com/photo-1453728013993-6d66e9c9123a?w=600", // camera lens/artifact
                    "https://images.unsplash.com/photo-1509198397868-475647b2a1e5?w=600"  // ancient scroll/book
                ];
                const index = Math.floor(Math.random() * mockItems.length);
                generatedUri = mockItems[index];
                printLLMResponse(`MockImageGen:${activeImageModel}`, 200, 1200, { image: generatedUri });
            }

            // Update image state
            useProjectStore.setState((s) => ({
                items: s.items.map((it) => it.id === itemId ? { ...it, image: generatedUri } : it),
                isDirty: true
            }));
            await useProjectStore.getState().save(true);
        } catch (err) {
            console.error("Failed to generate item image:", err);
            alert("生成形象失败，请检查网络或配置");
        } finally {
            setIsGenerating((prev) => ({ ...prev, [itemId]: false }));
        }
    };

    const handleGeneratePresetImage = async (itemId: string, stage: 'close' | 'use' | 'show') => {
        const item = items.find((i) => i.id === itemId);
        if (!item) return;

        const key = `gen-${itemId}-${stage}`;
        setIsGenerating((prev) => ({ ...prev, [key]: true }));

        try {
            const activeImageModel = resolveAssetModelKey("image", "sd-xl");
            const adapter = getAdapter(activeImageModel);

            let generatedUri = "";
            const stagePrompt = `${item.prompt}, view: ${stage}`;
            if (adapter && activeImageModel !== "sd-xl") {
                const submitRes = await adapter.submit(
                    { prompt: stagePrompt, _nodeId: `gen-item-${itemId}-${stage}-${Date.now()}` },
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
                printLLMRequest(`MockImageGenPreset:${activeImageModel}`, "SIMULATED_LOCAL_MOCK_URL", "POST", { "Content-Type": "application/json" }, { prompt: stagePrompt });
                await new Promise((r) => setTimeout(r, 1200));
                const mockItems = {
                    close: [
                        "https://images.unsplash.com/photo-1584622650111-993a426fbf0a?w=600",
                        "https://images.unsplash.com/photo-1513542789411-b6a5d4f31634?w=600"
                    ],
                    use: [
                        "https://images.unsplash.com/photo-1453728013993-6d66e9c9123a?w=600",
                        "https://images.unsplash.com/photo-1509198397868-475647b2a1e5?w=600"
                    ],
                    show: [
                        "https://images.unsplash.com/photo-1534224039826-c7a0dea0e66a?w=600",
                        "https://images.unsplash.com/photo-1526170375885-4d8ecf77b99f?w=600"
                    ]
                };
                const pool = mockItems[stage];
                generatedUri = pool[Math.floor(Math.random() * pool.length)];
                printLLMResponse(`MockImageGenPreset:${activeImageModel}`, 200, 1200, { image: generatedUri });
            }

            // Update preset image state dynamically
            const imageProp = `image_${stage}`;
            useProjectStore.setState((s) => ({
                items: s.items.map((it) => it.id === itemId ? { ...it, [imageProp]: generatedUri } : it),
                isDirty: true
            }));
            await useProjectStore.getState().save(true);
        } catch (err) {
            console.error(`Failed to generate preset ${stage} image:`, err);
            alert("生成预设形象失败");
        } finally {
            setIsGenerating((prev) => ({ ...prev, [key]: false }));
        }
    };

    const handleGenerateAll = async () => {
        const toGen = items.filter(it => !it.image);
        if (toGen.length === 0) {
            alert("所有道具都已有形象图");
            return;
        }
        if (!confirm(`将一键生成 ${toGen.length} 个道具的形象图，是否继续？`)) return;

        for (const item of toGen) {
            await handleGenerateImage(item.id);
        }
    };

    return (
        <div className="scroll-container">
            <div id="16_285" className="Pixso-frame-16_285">
                <EditorHeader title="道具配置" infoLabels={["默认图片模型: Image-2", `画风: ${visualStyle}`, "默认角色比例: 9:16"]} />
                <div id="16_309" className="Pixso-frame-16_309">
                    <div className="frame-content-16_309">
                        <EditorSidebar activeTab="物品" />

                        {/* Middle panel: Items List */}
                        <div id="16_361" className="stroke-wrapper-16_361">
                            <div className="Pixso-frame-16_361">
                                <div className="frame-content-16_361">
                                    <div id="16_362" className="stroke-wrapper-16_362">
                                        <div className="Pixso-frame-16_362">
                                            <div className="frame-content-16_362">
                                                <p id="16_363" className="Pixso-paragraph-16_363">
                                                    {"道具列表"}
                                                </p>
                                                <div id="16_364" className="Pixso-frame-16_364">
                                                    <p id="16_365" className="Pixso-paragraph-16_365" style={{ cursor: "pointer" }} onClick={handleGenerateAll}>
                                                        {"一键生成"}
                                                    </p>
                                                    <p id="16_366" className="Pixso-paragraph-16_366">
                                                        {"管理"}
                                                    </p>
                                                </div>
                                                <div id="16_367" className="Pixso-frame-16_367" style={{ cursor: "pointer" }} onClick={handleAddItem}>
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

                                    {/* Items list */}
                                    <div style={{ display: "flex", flexDirection: "column", gap: "10px", flex: 1, overflowY: "auto", paddingRight: "4px" }}>
                                        {items.length === 0 ? (
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
                                                <p>暂无物品数据，请先提取剧本资产</p>
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
                                            filteredItems.map((item) => {
                                                const isActive = item.id === selectedItemId;
                                                const displayMaterial = getAttributeValue(item.description, "材质", "未知");
                                                const displaySize = getAttributeValue(item.description, "尺寸", "未知");

                                                return (
                                                    <div
                                                        key={item.id}
                                                        className={`stroke-wrapper-16_377 ${isActive ? "active" : ""}`}
                                                        onClick={() => setSelectedItemId(item.id)}
                                                        style={{ cursor: "pointer" }}
                                                    >
                                                        <div className="Pixso-frame-16_377" style={{ background: isActive ? "rgba(139, 92, 246, 0.1)" : "" }}>
                                                            <div className="frame-content-16_377">
                                                                <div
                                                                    className="Pixso-frame-16_378"
                                                                    style={{
                                                                        backgroundImage: item.image ? `url(${item.image})` : "none",
                                                                        backgroundSize: "cover",
                                                                        backgroundPosition: "center",
                                                                        display: "flex",
                                                                        alignItems: "center",
                                                                        justifyContent: "center",
                                                                        backgroundRepeat: "no-repeat"
                                                                    }}
                                                                >
                                                                    {!item.image && (
                                                                        <div className="Pixso-vector-16_232" style={{ width: "16px", height: "16px", opacity: 0.3 }} />
                                                                    )}
                                                                </div>
                                                                <div className="Pixso-frame-16_379">
                                                                    <div className="frame-content-16_379">
                                                                        <p className="Pixso-paragraph-16_380">
                                                                            {item.name}
                                                                        </p>
                                                                        <p className="Pixso-paragraph-16_381">
                                                                            {`${displayMaterial}，${displaySize}`}
                                                                        </p>
                                                                    </div>
                                                                </div>
                                                                <span
                                                                    onClick={(e) => {
                                                                        e.stopPropagation();
                                                                        if (confirm(`确认要删除道具 "${item.name}" 吗？`)) {
                                                                            handleDeleteItem(item.id);
                                                                        }
                                                                    }}
                                                                    style={{
                                                                        marginLeft: "auto",
                                                                        color: "rgba(255,255,255,0.3)",
                                                                        fontSize: "11px",
                                                                        cursor: "pointer",
                                                                        padding: "4px"
                                                                    }}
                                                                    onMouseEnter={(e) => e.currentTarget.style.color = "#ef4444"}
                                                                    onMouseLeave={(e) => e.currentTarget.style.color = "rgba(255,255,255,0.3)"}
                                                                >
                                                                    删除
                                                                </span>
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

                        {/* Right panel: Item Details */}
                        <div id="16_427" className="stroke-wrapper-16_427">
                            <div className="Pixso-frame-16_427">
                                {activeItem ? (
                                    <div className="frame-content-16_427" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
                                        <p id="16_428" className="Pixso-paragraph-16_428">
                                            {`${activeItem.name} 基础形象`}
                                        </p>

                                        {/* Avatar view & generator button */}
                                        <div id="16_429" className="Pixso-frame-16_429" style={{ position: "relative" }}>
                                            <div className="frame-content-16_429" style={{ width: "100%", height: "100%" }}>
                                                <div
                                                    id="16_430"
                                                    className="Pixso-frame-16_430"
                                                    onClick={() => !isGenerating[activeItem.id] && handleGenerateImage(activeItem.id)}
                                                    style={{
                                                        width: "100%",
                                                        height: "100%",
                                                        backgroundImage: activeItem.image ? `url(${activeItem.image})` : "none",
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
                                                    {isGenerating[activeItem.id] ? (
                                                        <div style={{ color: "#a78bfa", fontSize: "13px", fontWeight: "bold" }}>
                                                            正在生成形象...
                                                        </div>
                                                    ) : !activeItem.image ? (
                                                        <>
                                                            <div className="Pixso-vector-16_9" style={{ width: "24px", height: "24px", opacity: 0.5 }} />
                                                            <span style={{ fontSize: "11px", color: "rgba(255,255,255,0.4)" }}>
                                                                点击生成形象
                                                            </span>
                                                        </>
                                                    ) : null}
                                                </div>
                                            </div>
                                        </div>

                                        {/* Attributes list */}
                                        <div id="16_434" style={{ display: "flex", flexDirection: "column", gap: "12px", marginTop: "14px", flex: 1, overflowY: "auto", paddingRight: "4px" }}>
                                            <div className="frame-content-16_434" style={{ display: "flex", gap: "10px" }}>
                                                {/* Material */}
                                                <div id="16_435" className="Pixso-frame-16_435" style={{ flex: 1 }}>
                                                    <div className="frame-content-16_435">
                                                        <p id="16_436" className="Pixso-paragraph-16_436">
                                                            {"材质"}
                                                        </p>
                                                        <div id="16_437" className="stroke-wrapper-16_437">
                                                            <div className="Pixso-frame-16_437">
                                                                <div className="frame-content-16_437">
                                                                    <input
                                                                        type="text"
                                                                        value={getAttributeValue(activeItem.description, "材质", "金属")}
                                                                        onChange={(e) => updateAttribute("材质", e.target.value)}
                                                                        style={{
                                                                            width: "100%",
                                                                            background: "transparent",
                                                                            border: "none",
                                                                            color: "#ffffff",
                                                                            fontSize: "12px",
                                                                            outline: "none"
                                                                        }}
                                                                    />
                                                                </div>
                                                            </div>
                                                            <div className="stroke-16_437"></div>
                                                        </div>
                                                    </div>
                                                </div>

                                                {/* Size */}
                                                <div id="16_439" className="Pixso-frame-16_439" style={{ flex: 1 }}>
                                                    <div className="frame-content-16_439">
                                                        <p id="16_440" className="Pixso-paragraph-16_440">
                                                            {"尺寸"}
                                                        </p>
                                                        <div id="16_441" className="stroke-wrapper-16_441">
                                                            <div className="Pixso-frame-16_441">
                                                                <div className="frame-content-16_441">
                                                                    <input
                                                                        type="text"
                                                                        value={getAttributeValue(activeItem.description, "尺寸", "常规")}
                                                                        onChange={(e) => updateAttribute("尺寸", e.target.value)}
                                                                        style={{
                                                                            width: "100%",
                                                                            background: "transparent",
                                                                            border: "none",
                                                                            color: "#ffffff",
                                                                            fontSize: "12px",
                                                                            outline: "none"
                                                                        }}
                                                                    />
                                                                </div>
                                                            </div>
                                                            <div className="stroke-16_441"></div>
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>

                                            {/* Gloss / Color */}
                                            <div id="16_443" className="Pixso-frame-16_443">
                                                <div className="frame-content-16_443">
                                                    <p id="16_444" className="Pixso-paragraph-16_444">
                                                        {"光泽"}
                                                    </p>
                                                    <div id="16_445" className="stroke-wrapper-16_445">
                                                        <div className="Pixso-frame-16_445">
                                                            <div className="frame-content-16_445">
                                                                <input
                                                                    type="text"
                                                                    value={getAttributeValue(activeItem.description, "光泽", "金属光泽")}
                                                                    onChange={(e) => updateAttribute("光泽", e.target.value)}
                                                                    style={{
                                                                        width: "100%",
                                                                        background: "transparent",
                                                                        border: "none",
                                                                        color: "#ffffff",
                                                                        fontSize: "12px",
                                                                        outline: "none"
                                                                    }}
                                                                />
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
                                                    <textarea
                                                        value={activeItem.philosophy}
                                                        onChange={(e) => {
                                                            const val = e.target.value;
                                                            useProjectStore.setState((s) => ({
                                                                items: s.items.map((it) => it.id === activeItem.id ? { ...it, philosophy: val } : it),
                                                                isDirty: true
                                                            }));
                                                            useProjectStore.getState().scheduleAutoSave("canvas");
                                                        }}
                                                        style={{
                                                            width: "100%",
                                                            height: "60px",
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

                                            {/* Prompt Input */}
                                            <div id="16_461_prompt" className="Pixso-frame-16_461" style={{ height: "auto", borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: "12px" }}>
                                                <div className="frame-content-16_461">
                                                    <p className="Pixso-paragraph-16_463" style={{ marginBottom: "6px" }}>
                                                         {"道具提示词"}
                                                    </p>
                                                    <textarea
                                                        value={activeItem.prompt}
                                                        onChange={(e) => {
                                                            const newPrompt = e.target.value;
                                                            useProjectStore.setState((s) => ({
                                                                items: s.items.map((it) => it.id === activeItem.id ? { ...it, prompt: newPrompt } : it),
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
                                                onClick={() => !isGenerating[activeItem.id] && handleGenerateImage(activeItem.id)}
                                                style={{
                                                    cursor: isGenerating[activeItem.id] ? "not-allowed" : "pointer",
                                                    opacity: isGenerating[activeItem.id] ? 0.7 : 1,
                                                    marginTop: "10px"
                                                }}
                                            >
                                                <div className="frame-content-16_468">
                                                    <div id="16_469" className="Pixso-frame-16_469">
                                                        <div className="frame-content-16_469">
                                                            <p id="16_470" className="Pixso-paragraph-16_470">
                                                                {isGenerating[activeItem.id] ? "生成中..." : "重新生成形象"}
                                                            </p>
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                ) : (
                                    <div style={{ display: "flex", flex: 1, alignItems: "center", justifyContent: "center", color: "rgba(255,255,255,0.4)" }}>
                                        请选择一个道具以查看详细信息
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
                                        </div>
                                    </div>
                                    <div className="stroke-16_473"></div>
                                </div>

                                {/* Poses presets list */}
                                <div style={{ display: "flex", flexDirection: "column", gap: "10px", flex: 1, overflowY: "auto", paddingRight: "4px", marginTop: "10px", width: "100%" }}>
                                    <div id="16_502" className="Pixso-frame-16_502" style={{ height: "auto", width: "100%" }}>
                                        <div className="frame-content-16_502" style={{ display: "flex", flexDirection: "row", flexWrap: "wrap", gap: "16px", height: "auto", width: "100%" }}>

                                            {/* Preset 1: Close-up Detail */}
                                            <div id="16_503" className="stroke-wrapper-16_503">
                                                <div className="Pixso-frame-16_503">
                                                    <div className="frame-content-16_503">
                                                        <div
                                                            id="16_504"
                                                            className="Pixso-frame-16_504"
                                                            style={{
                                                                backgroundImage: activeItem && (activeItem as any).image_close ? `url(${(activeItem as any).image_close})` : "none",
                                                                backgroundSize: "cover",
                                                                backgroundPosition: "center",
                                                                backgroundRepeat: "no-repeat"
                                                            }}
                                                        >
                                                            {!activeItem || !(activeItem as any).image_close ? (
                                                                <div id="16_505" className="Pixso-frame-16_505">
                                                                    <div id="16_506" className="stroke-wrapper-16_506">
                                                                        <div className="Pixso-rectangle-16_506"></div>
                                                                        <div className="stroke-16_506"></div>
                                                                    </div>
                                                                    <div id="16_507" className="Pixso-vector-16_507"></div>
                                                                    <div id="16_508" className="Pixso-vector-16_508"></div>
                                                                </div>
                                                            ) : null}
                                                            <div id="16_509" className="Pixso-frame-16_509">
                                                                <div className="frame-content-16_509">
                                                                    <p id="16_510" className="Pixso-paragraph-16_510">
                                                                        {"特写"}
                                                                    </p>
                                                                </div>
                                                            </div>
                                                        </div>
                                                        <div id="16_511" className="Pixso-frame-16_511">
                                                            <div className="frame-content-16_511">
                                                                <p id="16_512" className="Pixso-paragraph-16_512">
                                                                    {activeItem ? `${activeItem.name}特写` : "道具特写"}
                                                                </p>
                                                                <p id="16_513" className="Pixso-paragraph-16_513">
                                                                    {"特写材质/精细花纹细节描述"}
                                                                </p>
                                                            </div>
                                                        </div>
                                                        <div id="16_514" className="stroke-wrapper-16_514" style={{ cursor: "pointer" }} onClick={() => activeItem && handleGeneratePresetImage(activeItem.id, 'close')}>
                                                            <div className="Pixso-frame-16_514">
                                                                <div className="frame-content-16_514">
                                                                    <div id="16_516" className="Pixso-frame-16_516">
                                                                        <div className="frame-content-16_516">
                                                                            <p id="16_517" className="Pixso-paragraph-16_517">
                                                                                {isGenerating[`gen-${activeItem?.id}-close`] ? "生成中" : "生成"}
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

                                            {/* Preset 2: In-use State */}
                                            <div id="16_519" className="stroke-wrapper-16_519">
                                                <div className="Pixso-frame-16_519">
                                                    <div className="frame-content-16_519">
                                                        <div
                                                            id="16_520"
                                                            className="Pixso-frame-16_520"
                                                            style={{
                                                                backgroundImage: activeItem && (activeItem as any).image_use ? `url(${(activeItem as any).image_use})` : "none",
                                                                backgroundSize: "cover",
                                                                backgroundPosition: "center",
                                                                backgroundRepeat: "no-repeat"
                                                            }}
                                                        >
                                                            {!activeItem || !(activeItem as any).image_use ? (
                                                                <div id="16_521" className="Pixso-frame-16_521">
                                                                    <div id="16_522" className="stroke-wrapper-16_522">
                                                                        <div className="Pixso-rectangle-16_522"></div>
                                                                        <div className="stroke-16_522"></div>
                                                                    </div>
                                                                    <div id="16_523" className="Pixso-vector-16_523"></div>
                                                                    <div id="16_524" className="Pixso-vector-16_524"></div>
                                                                </div>
                                                            ) : null}
                                                            <div id="16_525" className="Pixso-frame-16_525">
                                                                <div className="frame-content-16_525">
                                                                    <p id="16_526" className="Pixso-paragraph-16_526">
                                                                        {"使用"}
                                                                    </p>
                                                                </div>
                                                            </div>
                                                        </div>
                                                        <div id="16_527" className="Pixso-frame-16_527">
                                                            <div className="frame-content-16_527">
                                                                <p id="16_528" className="Pixso-paragraph-16_528">
                                                                    {activeItem ? `${activeItem.name}使用` : "道具使用"}
                                                                </p>
                                                                <p id="16_529" className="Pixso-paragraph-16_529">
                                                                    {"人物持握/使用中状态描述"}
                                                                </p>
                                                            </div>
                                                        </div>
                                                        <div id="16_530" className="stroke-wrapper-16_530" style={{ cursor: "pointer" }} onClick={() => activeItem && handleGeneratePresetImage(activeItem.id, 'use')}>
                                                            <div className="Pixso-frame-16_530">
                                                                <div className="frame-content-16_530">
                                                                    <div id="16_532" className="Pixso-frame-16_532">
                                                                        <div className="frame-content-16_532">
                                                                            <p id="16_533" className="Pixso-paragraph-16_533">
                                                                                {isGenerating[`gen-${activeItem?.id}-use`] ? "生成中" : "生成"}
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

                                            {/* Preset 3: Showcase */}
                                            <div id="16_535" className="stroke-wrapper-16_535">
                                                <div className="Pixso-frame-16_535">
                                                    <div className="frame-content-16_535">
                                                        <div
                                                            id="16_536"
                                                            className="Pixso-frame-16_536"
                                                            style={{
                                                                backgroundImage: activeItem && (activeItem as any).image_show ? `url(${(activeItem as any).image_show})` : "none",
                                                                backgroundSize: "cover",
                                                                backgroundPosition: "center",
                                                                backgroundRepeat: "no-repeat"
                                                            }}
                                                        >
                                                            {!activeItem || !(activeItem as any).image_show ? (
                                                                <div id="16_537" className="Pixso-frame-16_537">
                                                                    <div id="16_538" className="stroke-wrapper-16_538">
                                                                        <div className="Pixso-rectangle-16_538"></div>
                                                                        <div className="stroke-16_538"></div>
                                                                    </div>
                                                                    <div id="16_539" className="Pixso-vector-16_539"></div>
                                                                    <div id="16_540" className="Pixso-vector-16_540"></div>
                                                                </div>
                                                            ) : null}
                                                            <div id="16_541" className="Pixso-frame-16_541">
                                                                <div className="frame-content-16_541">
                                                                    <p id="16_542" className="Pixso-paragraph-16_542">
                                                                        {"展示"}
                                                                    </p>
                                                                </div>
                                                            </div>
                                                        </div>
                                                        <div id="16_543" className="Pixso-frame-16_543">
                                                            <div className="frame-content-16_543">
                                                                <p id="16_544" className="Pixso-paragraph-16_544">
                                                                    {activeItem ? `${activeItem.name}展示` : "道具展示"}
                                                                </p>
                                                                <p id="16_545" className="Pixso-paragraph-16_545">
                                                                    {"静物展示/多角度外观细节展示"}
                                                                </p>
                                                            </div>
                                                        </div>
                                                        <div id="16_546" className="stroke-wrapper-16_546" style={{ cursor: "pointer" }} onClick={() => activeItem && handleGeneratePresetImage(activeItem.id, 'show')}>
                                                            <div className="Pixso-frame-16_546">
                                                                <div className="frame-content-16_546">
                                                                    <div id="16_547" className="Pixso-frame-16_547">
                                                                        <div className="frame-content-16_547">
                                                                            <p id="16_548" className="Pixso-paragraph-16_548">
                                                                                {isGenerating[`gen-${activeItem?.id}-show`] ? "生成中" : "生成"}
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

export default Frame161000;
