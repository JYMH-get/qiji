import { useState, useRef } from "react";
import { 
  Play, 
  Pause, 
  ChevronLeft, 
  ChevronRight, 
  Search, 
  Upload, 
  Plus, 
  Image as ImageIcon, 
  Sparkles,
  Video,
  Maximize2
} from "lucide-react";

interface StoryboardFrame {
    id: number;
    shotNumber: string;
    type: string;
    description: string;
    cameraMovement: string;
    duration: string;
    image?: string;
    videoGenerated: boolean;
    videoUrl?: string;
    model?: string;
    resolution?: string;
    aspectRatio?: string;
    title?: string;
}

const FrameStoryboard = () => {

    // 10 cinematic mock frames
    const [frames, setFrames] = useState<StoryboardFrame[]>([
        {
            id: 1,
            shotNumber: "1-1",
            title: "画面水平，白发起臣",
            type: "远景平视 (Long Shot)",
            description: "预计时长13秒，以远景平视镜头展开，狂风掠过空旷荒凉的阎王殿废墟大厅，枯叶卷起，空气中充满冷峻沉寂的质感。",
            cameraMovement: "慢速前推镜头 (Dolly In Slow)",
            duration: "13s",
            image: "https://images.unsplash.com/photo-1518709268805-4e9042af9f23?w=600",
            videoGenerated: true,
            videoUrl: "https://assets.mixkit.co/videos/preview/mixkit-dramatic-dark-clouds-time-lapse-40248-large.mp4",
            model: "Seedance 2.0 Pro",
            resolution: "720p",
            aspectRatio: "16:9"
        },
        {
            id: 2,
            shotNumber: "1-2",
            title: "远景平视，镇国五虎山",
            type: "远景平视 (Long Shot)",
            description: "预计时长15秒，男主角中青衣壮汉，站立在荒凉的关隘上，狂风吹起斗篷。镜头从全景缓慢向下摇移，突显荒凉山谷与冷峻对立感。",
            cameraMovement: "震动跟踪镜头 (Shake & Track)",
            duration: "15s",
            image: "https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?w=600",
            videoGenerated: false,
            model: "Seedance 2.0 Pro",
            resolution: "720p",
            aspectRatio: "16:9"
        },
        {
            id: 3,
            shotNumber: "1-3",
            title: "2032年，聚集黑森林",
            type: "全景 (Long Shot)",
            description: "预计时长15秒，时间是2032年，黑森林深处内部落满枯叶与积雪。镜头缓缓移向主角背影，昏暗雾气中似有影子攒动，营造极致悬疑紧张感。",
            cameraMovement: "左摇移镜头 (Pan Left)",
            duration: "15s",
            image: "https://images.unsplash.com/photo-1502082553048-f009c37129b9?w=600",
            videoGenerated: false,
            model: "Seedance 2.0 Pro",
            resolution: "720p",
            aspectRatio: "16:9"
        },
        {
            id: 4,
            shotNumber: "1-4",
            title: "国王降临，强盗在咆哮",
            type: "微特写 (Extreme Close-up)",
            description: "预计时长15秒，白起右手缓缓握紧腰间青铜古剑柄，指节因用力微微发白。山峰峡谷之巅，强盗马贼站在怪石嶙峋边缘怒吼咆哮。",
            cameraMovement: "下俯上摇镜头 (Tilt Up)",
            duration: "15s",
            image: "https://images.unsplash.com/photo-1459305272254-33a7d593a851?w=600",
            videoGenerated: false,
            model: "Seedance 2.0 Pro",
            resolution: "720p",
            aspectRatio: "16:9"
        },
        {
            id: 5,
            shotNumber: "1-5",
            title: "黑色火山，红云漂移",
            type: "中景 (Medium Shot)",
            description: "预计时长15秒，敌境黑色火山山口，红云狂野漂移，地表熔岩纹理交织，黑红强弱对比展现深渊决战前夕的窒息氛围。",
            cameraMovement: "慢速拉远 (Dolly Out)",
            duration: "15s",
            image: "https://images.unsplash.com/photo-1509198397868-475647b2a1e5?w=600",
            videoGenerated: false,
            model: "Seedance 2.0 Pro",
            resolution: "720p",
            aspectRatio: "16:9"
        },
        {
            id: 6,
            shotNumber: "1-6",
            title: "盘山公路，狂野飙车",
            type: "全景 (Long Shot)",
            description: "预计时长15秒，越野车轮与盘山沙尘路段剧烈摩擦，尘雾升空，战车轰鸣，画面充满重工业废土飙车的狂野张力。",
            cameraMovement: "环绕镜头 (Orbit Shot)",
            duration: "15s",
            image: "https://images.unsplash.com/photo-1506012787146-f92b2d7d6d96?w=600",
            videoGenerated: false,
            model: "Seedance 2.0 Pro",
            resolution: "720p",
            aspectRatio: "16:9"
        },
        {
            id: 7,
            shotNumber: "1-7",
            title: "废墟都市，怪兽咆哮",
            type: "全景 (Long Shot)",
            description: "预计时长15秒，残缺的大厦在黑雨中战栗，虚空深渊怪兽自红雾裂缝伸出巨爪，低频咆哮声波在空气中凝结成震荡细纹。",
            cameraMovement: "俯瞰倾斜 (Crane Down & Tilt)",
            duration: "15s",
            image: "https://images.unsplash.com/photo-1536566482680-fca31930a0bd?w=600",
            videoGenerated: false,
            model: "Seedance 2.0 Pro",
            resolution: "720p",
            aspectRatio: "16:9"
        },
        {
            id: 8,
            shotNumber: "1-8",
            title: "暮色村口，三生竹林",
            type: "特写 (Close-up)",
            description: "预计时长15秒，暮色掩映三生石畔，竹海翻涌绿色波澜。红衣背影女子发丝被微风拂过，手握油纸伞，脚下尘沙静立，画风唯美伤感。",
            cameraMovement: "平滑横移 (Slide Left)",
            duration: "15s",
            image: "https://images.unsplash.com/photo-1509316975850-ff9c5deb0cd9?w=600",
            videoGenerated: false,
            model: "Seedance 2.0 Pro",
            resolution: "720p",
            aspectRatio: "16:9"
        },
        {
            id: 9,
            shotNumber: "1-9",
            title: "强盗出击，铁骑轰鸣",
            type: "中景 (Medium Shot)",
            description: "预计时长15秒，沙场黑雾重重，战马踩踏冰冷泥浆，铠甲金属折射微弱血光，镜头快速穿梭行军队列，强调战争的惨烈铁血气息。",
            cameraMovement: "疾速推轨 (Track Fast)",
            duration: "15s",
            image: "https://images.unsplash.com/photo-1534447677768-be436bb09401?w=600",
            videoGenerated: false,
            model: "Seedance 2.0 Pro",
            resolution: "720p",
            aspectRatio: "16:9"
        },
        {
            id: 10,
            shotNumber: "1-10",
            title: "最终决战，神魔对峙",
            type: "全景 (Long Shot)",
            description: "预计时长15秒，古老大殿顶端碎裂，金光与紫电撕扯苍穹。神明与恶魔于虚空对立，两股澎湃力场相撞，冲击波横扫废墟。",
            cameraMovement: "静态仰角镜头 (Low Angle)",
            duration: "15s",
            image: undefined,
            videoGenerated: false,
            model: "Seedance 2.0 Pro",
            resolution: "720p",
            aspectRatio: "16:9"
        }
    ]);

    const [activeFrameId, setActiveFrameId] = useState<number>(1);
    const activeFrame = frames.find(f => f.id === activeFrameId) || frames[0];

    // Left Panel Form States (loaded per active frame)
    const [prompt, setPrompt] = useState<string>(activeFrame.description);
    const [model, setModel] = useState<string>(activeFrame.model || "Seedance 2.0 Pro");
    const [durationVal, setDurationVal] = useState<string>(activeFrame.duration);
    const [aspectRatio, setAspectRatio] = useState<string>(activeFrame.aspectRatio || "16:9");
    const [resolution, setResolution] = useState<string>(activeFrame.resolution || "720p");
    
    // Left panel extra flags
    const [leftTab, setLeftTab] = useState<"image" | "video" | "config">("image");
    const [ignoreGlobalStyle, setIgnoreGlobalStyle] = useState<boolean>(false);
    const [commonStyle, setCommonStyle] = useState<string>("3D动漫半真人写实, 昏暗影调, 逼真肌理...");
    const [useSetStyleWords, setUseSetStyleWords] = useState<boolean>(true);
    const [styleSync, setStyleSync] = useState<boolean>(true);
    const [alignFrames, setAlignFrames] = useState<boolean>(true);

    // Generation states
    const [isGeneratingSingle, setIsGeneratingSingle] = useState<boolean>(false);
    const [singleProgress, setSingleProgress] = useState<number>(0);
    const [isGeneratingAll, setIsGeneratingAll] = useState<boolean>(false);
    const [allProgress, setAllProgress] = useState<number>(0);

    // Right workbench states
    const [assetTab, setAssetTab] = useState<"storyboard" | "local" | "favorite" | "history" | "drafts">("storyboard");
    const [searchQuery, setSearchQuery] = useState("");
    const [isPlaying, setIsPlaying] = useState(false);
    const [playerZoom, setPlayerZoom] = useState("适应");

    // Local assets mocks for upload preview loaded in Assets Panel
    const localAssets = [
        { id: "l1", url: "https://images.unsplash.com/photo-1579783902614-a3fb3927b6a5?w=200", type: "image" as const, title: "中国风水墨概念图" },
        { id: "l2", url: "https://images.unsplash.com/photo-1541701494587-cb58502866ab?w=200", type: "image" as const, title: "炫酷科技光感素材" },
        { id: "l3", url: "https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=200", type: "image" as const, title: "流体渲染艺术参考" },
        { id: "l4", url: "https://images.unsplash.com/photo-1518709768805-4e9042af9f23?w=200", type: "image" as const, title: "阎王殿背景侧面" }
    ];

    const timelineContainerRef = useRef<HTMLDivElement>(null);

    // Auto sync state when active frame changes
    const handleSelectFrame = (id: number) => {
        if (isGeneratingSingle) return; // Block during generation
        setActiveFrameId(id);
        const nextFrame = frames.find(f => f.id === id);
        if (nextFrame) {
            setPrompt(nextFrame.description);
            setModel(nextFrame.model || "Seedance 2.0 Pro");
            setDurationVal(nextFrame.duration);
            setResolution(nextFrame.resolution || "720p");
            setAspectRatio(nextFrame.aspectRatio || "16:9");
            setIsPlaying(false);
        }
    };

    // Save configuration states back to active frame card object
    const updateActiveFrame = (fields: Partial<StoryboardFrame>) => {
        setFrames(prev => prev.map(f => f.id === activeFrameId ? { ...f, ...fields } : f));
    };

    const handlePromptChange = (val: string) => {
        setPrompt(val);
        updateActiveFrame({ description: val });
    };

    // Simulated single shot generation with beautiful progress bar
    const handleGenerateSingle = () => {
        if (isGeneratingSingle) return;
        setIsGeneratingSingle(true);
        setSingleProgress(0);
        setIsPlaying(false);

        const interval = setInterval(() => {
            setSingleProgress(prev => {
                if (prev >= 100) {
                    clearInterval(interval);
                    setTimeout(() => {
                        setIsGeneratingSingle(false);
                        // Mark active frame as generated with mock image and video
                        setFrames(prevFrames => prevFrames.map(f => {
                            if (f.id === activeFrameId) {
                                return {
                                    ...f,
                                    videoGenerated: true,
                                    image: f.image || "https://images.unsplash.com/photo-1509198397868-475647b2a1e5?w=600",
                                    videoUrl: "https://assets.mixkit.co/videos/preview/mixkit-dramatic-dark-clouds-time-lapse-40248-large.mp4"
                                };
                            }
                            return f;
                        }));
                    }, 400);
                    return 100;
                }
                return prev + 10;
            });
        }, 200);
    };

    // Simulated all project generation
    const handleGenerateAll = () => {
        if (isGeneratingAll) return;
        setIsGeneratingAll(true);
        setAllProgress(0);

        const interval = setInterval(() => {
            setAllProgress(prev => {
                if (prev >= 100) {
                    clearInterval(interval);
                    setTimeout(() => {
                        setIsGeneratingAll(false);
                        // Populate all frames with images and generate video status
                        setFrames(prevFrames => prevFrames.map((f) => ({
                            ...f,
                            videoGenerated: true,
                            image: f.image || `https://images.unsplash.com/photo-1534447677768-be436bb09401?w=600`,
                            videoUrl: "https://assets.mixkit.co/videos/preview/mixkit-dramatic-dark-clouds-time-lapse-40248-large.mp4"
                        })));
                    }, 500);
                    return 100;
                }
                return prev + 5;
            });
        }, 150);
    };

    // AI write/fill helper
    const handleAIWrite = () => {
        const cinematicPrompts = [
            "镜头慢速推向王座，两旁侍卫神色冰冷。金碧辉煌的宫殿深处，厚重帘幕无风自动，浮现神秘金色龙鳞残影。",
            "远景，地平线金黄余晖拉长荒漠山峦阴影，一骑红尘疾驰冲破落日沙海，漫天风沙在广角镜头下勾勒出孤独画卷。",
            "微距慢动作，古老水滴落在水面泛起一圈圈散发金色磷光的涟漪，反射出古书上的魔法咒文，周围光影流转。",
            "中景侧面，大雨倾盆打湿石板路面，霓虹灯倒影破碎。主角打着黑色雨伞孤身前行，雨丝反光泛起蒸汽波科幻感。"
        ];
        const randomPrompt = cinematicPrompts[Math.floor(Math.random() * cinematicPrompts.length)];
        handlePromptChange(randomPrompt);
    };

    // Scroll timeline track horizontally
    const scrollTimeline = (direction: "left" | "right") => {
        if (timelineContainerRef.current) {
            const amount = 300;
            timelineContainerRef.current.scrollBy({
                left: direction === "left" ? -amount : amount,
                behavior: "smooth"
            });
        }
    };

    return (
        <div style={{ width: "100vw", height: "100%", background: "#050608", color: "#e3e7f0", display: "flex", flexDirection: "row", overflow: "hidden", fontFamily: "system-ui, -apple-system, sans-serif" }}>
            
            {/* Global style tag for custom component classes */}
            <style>{`
                /* CSS custom overrides */
                .qiji-scroll-container::-webkit-scrollbar {
                    width: 4px;
                    height: 4px;
                }
                .qiji-scroll-container::-webkit-scrollbar-track {
                    background: rgba(255, 255, 255, 0.01);
                }
                .qiji-scroll-container::-webkit-scrollbar-thumb {
                    background: rgba(255, 255, 255, 0.08);
                    border-radius: 4px;
                }
                .qiji-scroll-container::-webkit-scrollbar-thumb:hover {
                    background: rgba(255, 255, 255, 0.15);
                }

                .qiji-switch {
                    position: relative;
                    display: inline-block;
                    width: 28px;
                    height: 15px;
                }
                .qiji-switch input {
                    opacity: 0;
                    width: 0;
                    height: 0;
                }
                .qiji-slider {
                    position: absolute;
                    cursor: pointer;
                    top: 0; left: 0; right: 0; bottom: 0;
                    background-color: rgba(255, 255, 255, 0.08);
                    transition: .2s;
                    border-radius: 10px;
                }
                .qiji-slider:before {
                    position: absolute;
                    content: "";
                    height: 11px;
                    width: 11px;
                    left: 2px;
                    bottom: 2px;
                    background-color: #abb2bf;
                    transition: .2s;
                    border-radius: 50%;
                }
                input:checked + .qiji-slider {
                    background-color: #8b5cf6;
                }
                input:checked + .qiji-slider:before {
                    transform: translateX(13px);
                    background-color: #ffffff;
                }

                .qiji-pill-btn {
                    padding: 4px 10px;
                    border-radius: 12px;
                    font-size: 11px;
                    border: 1px solid rgba(255, 255, 255, 0.08);
                    background: transparent;
                    color: rgba(255,255,255,0.6);
                    cursor: pointer;
                    transition: all 0.2s ease;
                }
                .qiji-pill-btn:hover {
                    color: #fff;
                    border-color: rgba(255, 255, 255, 0.2);
                    background: rgba(255, 255, 255, 0.02);
                }
                .qiji-pill-btn.active {
                    background: #8b5cf6;
                    color: #fff;
                    border-color: #8b5cf6;
                    font-weight: bold;
                }

                .qiji-action-btn-outline {
                    padding: 5px 8px;
                    font-size: 10px;
                    color: #58a6ff;
                    border: 1px solid rgba(88, 166, 255, 0.2);
                    border-radius: 4px;
                    background: rgba(88, 166, 255, 0.03);
                    cursor: pointer;
                    transition: all 0.2s ease;
                    white-space: nowrap;
                }
                .qiji-action-btn-outline:hover {
                    background: rgba(88, 166, 255, 0.1);
                    border-color: rgba(88, 166, 255, 0.4);
                }

                .qiji-asset-grid-card {
                    position: relative;
                    border-radius: 6px;
                    background: rgba(255, 255, 255, 0.01);
                    border: 1px solid rgba(255, 255, 255, 0.04);
                    overflow: hidden;
                    cursor: pointer;
                    transition: all 0.2s ease;
                }
                .qiji-asset-grid-card:hover {
                    border-color: rgba(139, 92, 246, 0.4);
                    background: rgba(255, 255, 255, 0.03);
                    transform: translateY(-2px);
                }

                .qiji-timeline-card {
                    min-width: 220px;
                    width: 220px;
                    border-radius: 6px;
                    background: rgba(255, 255, 255, 0.02);
                    border: 1px solid rgba(255, 255, 255, 0.06);
                    cursor: pointer;
                    overflow: hidden;
                    display: flex;
                    flex-direction: column;
                    transition: all 0.2s ease;
                }
                .qiji-timeline-card:hover {
                    transform: translateY(-3px);
                    border-color: rgba(255, 255, 255, 0.2);
                }
                .qiji-timeline-card.active {
                    background: rgba(139, 92, 246, 0.08);
                    border: 2px solid #8b5cf6;
                    box-shadow: 0 0 16px rgba(139, 92, 246, 0.25);
                }

                .qiji-header-tab {
                    padding: 6px 12px;
                    font-size: 11px;
                    border: none;
                    border-radius: 4px;
                    background: transparent;
                    color: rgba(255,255,255,0.5);
                    cursor: pointer;
                    font-weight: 500;
                    transition: all 0.2s ease;
                }
                .qiji-header-tab:hover {
                    color: #fff;
                    background: rgba(255, 255, 255, 0.02);
                }
                .qiji-header-tab.active {
                    background: #8b5cf6;
                    color: #fff;
                    font-weight: bold;
                }
            `}</style>

            {/* ── 左边栏：提示词处理与素材选择区 ── */}
            <div style={{ width: "360px", flexShrink: 0, borderRight: "1px solid rgba(255,255,255,0.07)", background: "#0a0b0f", display: "flex", flexDirection: "column", height: "100%" }}>
                {/* AI 生成 Header */}
                <div style={{ padding: "12px 14px", borderBottom: "1px solid rgba(255,255,255,0.06)", display: "flex", flexDirection: "column", gap: "10px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span style={{ fontSize: "14px", fontWeight: "bold", color: "#fff", display: "flex", alignItems: "center", gap: "6px" }}>
                            <Sparkles className="h-4 w-4 text-purple-400" /> AI 生成
                        </span>
                        <div style={{ display: "flex", background: "rgba(255,255,255,0.03)", padding: "2px", borderRadius: "6px" }}>
                            <button 
                                onClick={() => setLeftTab("image")}
                                className={`qiji-header-tab ${leftTab === "image" ? "active" : ""}`}
                            >
                                融合主图
                            </button>
                            <button 
                                onClick={() => setLeftTab("video")}
                                className={`qiji-header-tab ${leftTab === "video" ? "active" : ""}`}
                            >
                                主视频
                            </button>
                            <button 
                                onClick={() => setLeftTab("config")}
                                className={`qiji-header-tab ${leftTab === "config" ? "active" : ""}`}
                            >
                                生成配置
                            </button>
                        </div>
                    </div>
                </div>

                {/* Form fields - Scrollable */}
                <div className="qiji-scroll-container" style={{ flex: 1, overflowY: "auto", padding: "14px", display: "flex", flexDirection: "column", gap: "14px" }}>
                    
                    {leftTab === "image" && (
                        <>


                            {/* AI Model selector */}
                            <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
                                <label style={{ fontSize: "11px", color: "rgba(255,255,255,0.5)" }}>AI 模型</label>
                                <select 
                                    value={model} 
                                    onChange={(e) => { setModel(e.target.value); updateActiveFrame({ model: e.target.value }); }}
                                    style={{ width: "100%", padding: "7px 10px", borderRadius: "6px", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#fff", fontSize: "12px", outline: "none", cursor: "pointer" }}
                                >
                                    <option value="Seedance 2.0 Pro">Seedance 2.0 Pro</option>
                                    <option value="Sora Turbo v2">Sora Turbo v2 (创意插画)</option>
                                    <option value="Luma-Dreamer">Luma Dreamer v3 (极致写实)</option>
                                </select>
                            </div>



                            {/* Prompt text area */}
                            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                    <span style={{ fontSize: "11px", color: "rgba(255,255,255,0.5)", fontWeight: "500" }}>Prompt 提示词 <span style={{ color: "#ff4d4f" }}>*</span></span>
                                    <label style={{ display: "flex", alignItems: "center", gap: "3px", fontSize: "10px", color: "rgba(255,255,255,0.4)", cursor: "pointer" }}>
                                        <input 
                                            type="checkbox" 
                                            checked={ignoreGlobalStyle} 
                                            onChange={(e) => setIgnoreGlobalStyle(e.target.checked)} 
                                            style={{ cursor: "pointer" }}
                                        />
                                        <span>忽略全局风</span>
                                    </label>
                                </div>
                                <div style={{ fontSize: "10px", color: "rgba(255,255,255,0.35)", wordBreak: "break-all" }}>
                                    画风：<span style={{ color: "#a78bfa" }}>3D动漫半真人写实, 昏暗影调...</span>
                                </div>
                                <div style={{ position: "relative" }}>
                                    <textarea
                                        value={prompt}
                                        onChange={(e) => handlePromptChange(e.target.value)}
                                        placeholder="请输入提示词，或点击下方 'AI 帮写'"
                                        style={{ width: "100%", height: "85px", padding: "10px", borderRadius: "6px", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", color: "#fff", fontSize: "12px", outline: "none", resize: "none", lineHeight: "1.4" }}
                                    />
                                    <button 
                                        onClick={handleAIWrite}
                                        style={{ position: "absolute", bottom: "8px", right: "8px", padding: "3px 8px", background: "#8b5cf6", border: "none", color: "#fff", borderRadius: "4px", fontSize: "10px", cursor: "pointer", display: "flex", alignItems: "center", gap: "2px", boxShadow: "0 2px 5px rgba(0,0,0,0.3)" }}
                                    >
                                        <Sparkles className="h-3 w-3" /> AI 帮写
                                    </button>
                                </div>
                            </div>

                            {/* Common style area */}
                            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                                <label style={{ fontSize: "11px", color: "rgba(255,255,255,0.5)" }}>共同画风 (可选) 可自定义分镜画风体</label>
                                <div style={{ display: "flex", background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "6px", overflow: "hidden" }}>
                                    <input 
                                        type="text" 
                                        value={commonStyle}
                                        onChange={(e) => setCommonStyle(e.target.value)}
                                        style={{ flex: 1, padding: "6px 8px", background: "transparent", border: "none", outline: "none", color: "#fff", fontSize: "11px" }}
                                    />
                                    <button style={{ padding: "0 10px", background: "rgba(255,255,255,0.05)", border: "none", borderLeft: "1px solid rgba(255,255,255,0.08)", color: "#a78bfa", fontSize: "10px", cursor: "pointer" }}>+ 关联</button>
                                </div>
                                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "2px" }}>
                                    <label style={{ display: "flex", alignItems: "center", gap: "4px", fontSize: "10px", color: "rgba(255,255,255,0.4)", cursor: "pointer" }}>
                                        <input 
                                            type="checkbox" 
                                            checked={useSetStyleWords}
                                            onChange={(e) => setUseSetStyleWords(e.target.checked)}
                                            style={{ cursor: "pointer" }}
                                        />
                                        <span>以设定画风词</span>
                                    </label>
                                    <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                                        <span style={{ fontSize: "10px", color: "rgba(255,255,255,0.4)" }}>画风同步</span>
                                        <label className="qiji-switch">
                                            <input 
                                                type="checkbox" 
                                                checked={styleSync} 
                                                onChange={(e) => setStyleSync(e.target.checked)} 
                                            />
                                            <span className="qiji-slider"></span>
                                        </label>
                                    </div>
                                </div>
                            </div>

                            {/* Duration & Resolution */}
                            <div style={{ display: "flex", gap: "10px" }}>
                                <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "5px" }}>
                                    <label style={{ fontSize: "11px", color: "rgba(255,255,255,0.5)" }}>时长(秒) <span style={{ color: "#ff4d4f" }}>*</span></label>
                                    <select 
                                        value={durationVal} 
                                        onChange={(e) => { setDurationVal(e.target.value); updateActiveFrame({ duration: e.target.value }); }}
                                        style={{ width: "100%", padding: "6px 8px", borderRadius: "6px", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#fff", fontSize: "11px", outline: "none", cursor: "pointer" }}
                                    >
                                        <option value="2.5s">2.5s</option>
                                        <option value="3s">3.0s</option>
                                        <option value="4s">4.0s</option>
                                        <option value="5s">5.0s</option>
                                        <option value="13s">13.0s</option>
                                        <option value="15s">15.0s</option>
                                    </select>
                                </div>
                                <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "5px" }}>
                                    <label style={{ fontSize: "11px", color: "rgba(255,255,255,0.5)" }}>分辨率 (可选)</label>
                                    <select 
                                        value={resolution} 
                                        onChange={(e) => { setResolution(e.target.value); updateActiveFrame({ resolution: e.target.value }); }}
                                        style={{ width: "100%", padding: "6px 8px", borderRadius: "6px", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#fff", fontSize: "11px", outline: "none", cursor: "pointer" }}
                                    >
                                        <option value="720p">720p (标清)</option>
                                        <option value="1080p">1080p (高清)</option>
                                        <option value="4k">4k (超清)</option>
                                    </select>
                                </div>
                            </div>

                            {/* Aspect Ratio & Frame Alignment */}
                            <div style={{ display: "flex", gap: "10px" }}>
                                <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "5px" }}>
                                    <label style={{ fontSize: "11px", color: "rgba(255,255,255,0.5)" }}>宽高比 <span style={{ color: "#ff4d4f" }}>*</span></label>
                                    <select 
                                        value={aspectRatio} 
                                        onChange={(e) => { setAspectRatio(e.target.value); updateActiveFrame({ aspectRatio: e.target.value }); }}
                                        style={{ width: "100%", padding: "6px 8px", borderRadius: "6px", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#fff", fontSize: "11px", outline: "none", cursor: "pointer" }}
                                    >
                                        <option value="16:9">16:9 (横屏)</option>
                                        <option value="9:16">9:16 (竖屏)</option>
                                        <option value="1:1">1:1 (正方形)</option>
                                    </select>
                                </div>
                                <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "5px", justifyContent: "flex-end" }}>
                                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "rgba(255,255,255,0.02)", padding: "8px 10px", borderRadius: "6px", height: "30px" }}>
                                        <span style={{ fontSize: "11px", color: "rgba(255,255,255,0.7)" }}>画面对齐</span>
                                        <label className="qiji-switch">
                                            <input 
                                                type="checkbox" 
                                                checked={alignFrames} 
                                                onChange={(e) => setAlignFrames(e.target.checked)} 
                                            />
                                            <span className="qiji-slider"></span>
                                        </label>
                                    </div>
                                </div>
                            </div>
                        </>
                    )}

                    {leftTab === "video" && (
                        <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                            <p style={{ fontSize: "11px", color: "rgba(255,255,255,0.4)", margin: 0 }}>主视频模式：可通过运动系数与运镜设置直接生成视频剪辑片段。</p>
                            
                            <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
                                <label style={{ fontSize: "11px", color: "rgba(255,255,255,0.5)" }}>视频运动系数 (Motion Strength)</label>
                                <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                                    <input type="range" min="1" max="10" defaultValue="5" style={{ flex: 1, accentColor: "#8b5cf6" }} />
                                    <span style={{ fontSize: "12px", color: "#a78bfa", fontFamily: "monospace" }}>5</span>
                                </div>
                            </div>

                            <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
                                <label style={{ fontSize: "11px", color: "rgba(255,255,255,0.5)" }}>镜头运动预设 (Camera Movement)</label>
                                <select style={{ width: "100%", padding: "7px 10px", borderRadius: "6px", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#fff", fontSize: "12px", cursor: "pointer" }}>
                                    <option>慢速前推镜头 (Dolly In Slow)</option>
                                    <option>震动跟踪镜头 (Shake & Track)</option>
                                    <option>左摇移镜头 (Pan Left)</option>
                                    <option>下俯上摇镜头 (Tilt Up)</option>
                                    <option>静态视角 (Static View)</option>
                                </select>
                            </div>

                            <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
                                <label style={{ fontSize: "11px", color: "rgba(255,255,255,0.5)" }}>帧率设置</label>
                                <div style={{ display: "flex", gap: "8px" }}>
                                    {["24 fps", "30 fps", "60 fps"].map((fps, i) => (
                                        <button key={fps} className={`qiji-pill-btn ${i === 1 ? "active" : ""}`} style={{ flex: 1 }}>{fps}</button>
                                    ))}
                                </div>
                            </div>
                        </div>
                    )}

                    {leftTab === "config" && (
                        <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                            <p style={{ fontSize: "11px", color: "rgba(255,255,255,0.4)", margin: 0 }}>高级配置：控制扩散模型采样精度与引导权重参数。</p>
                            
                            <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
                                <label style={{ fontSize: "11px", color: "rgba(255,255,255,0.5)" }}>采样方法 (Sampler)</label>
                                <select style={{ width: "100%", padding: "7px 10px", borderRadius: "6px", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#fff", fontSize: "12px" }}>
                                    <option>Euler a</option>
                                    <option>DPM++ 2M Karras</option>
                                    <option>DDIM</option>
                                    <option>Heun</option>
                                </select>
                            </div>

                            <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
                                <label style={{ fontSize: "11px", color: "rgba(255,255,255,0.5)" }}>步数 (Steps)</label>
                                <input type="range" min="15" max="50" defaultValue="30" style={{ accentColor: "#8b5cf6" }} />
                            </div>

                            <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
                                <label style={{ fontSize: "11px", color: "rgba(255,255,255,0.5)" }}>文本引导权重 (CFG Scale)</label>
                                <input type="range" min="4" max="15" step="0.5" defaultValue="7.5" style={{ accentColor: "#8b5cf6" }} />
                            </div>

                            <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
                                <label style={{ fontSize: "11px", color: "rgba(255,255,255,0.5)" }}>随机种子 (Seed)</label>
                                <div style={{ display: "flex", gap: "8px" }}>
                                    <input type="text" placeholder="-1 (随机)" style={{ flex: 1, padding: "6px 8px", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "6px", color: "#fff", fontSize: "11px" }} />
                                    <button style={{ padding: "0 10px", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "6px", color: "#a78bfa", fontSize: "10px", cursor: "pointer" }}>随机</button>
                                </div>
                            </div>
                        </div>
                    )}
                </div>

                {/* Left Panel Footer Action Buttons */}
                <div style={{ padding: "12px 14px", borderTop: "1px solid rgba(255,255,255,0.06)", display: "flex", gap: "8px", background: "rgba(0,0,0,0.2)" }}>
                    <button style={{ flex: 1, padding: "8px 0", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", color: "rgba(255,255,255,0.7)", borderRadius: "6px", fontSize: "12px", cursor: "pointer", fontWeight: "500", transition: "all 0.2s" }} className="hover:bg-white/10">
                        保存草稿
                    </button>
                    <button 
                        onClick={handleGenerateSingle}
                        disabled={isGeneratingSingle}
                        style={{ flex: 1.8, padding: "8px 0", background: isGeneratingSingle ? "rgba(139, 92, 246, 0.4)" : "linear-gradient(135deg, #7c3aed, #ec4899)", border: "none", color: "#fff", borderRadius: "6px", fontSize: "12px", cursor: isGeneratingSingle ? "not-allowed" : "pointer", fontWeight: "bold", display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", boxShadow: "0 4px 10px rgba(124, 58, 237, 0.2)" }}
                    >
                        <Sparkles className={`h-3.5 w-3.5 ${isGeneratingSingle ? "animate-spin" : ""}`} />
                        {isGeneratingSingle ? `生成中 (${singleProgress}%)` : "生成视频 预计 61 积分"}
                    </button>
                </div>
            </div>

            {/* ── 右边栏：类似于剪辑软件的面板 ── */}
            <div style={{ flex: 1, display: "flex", flexDirection: "column", height: "100%" }}>
                
                {/* Top Half: Video Player + Asset Library */}
                <div style={{ flex: 3.2, display: "flex", flexDirection: "row", borderBottom: "1px solid rgba(255,255,255,0.07)", overflow: "hidden" }}>
                    
                    {/* Top Left Half: Video Player Viewport */}
                    <div style={{ flex: 1, display: "flex", flexDirection: "column", background: "#030406", overflow: "hidden" }}>
                        {/* Title header */}
                        <div style={{ padding: "8px 14px", borderBottom: "1px solid rgba(255,255,255,0.04)", display: "flex", justifyContent: "space-between", alignItems: "center", background: "#07080a" }}>
                            <span style={{ fontSize: "11px", color: "rgba(255,255,255,0.5)", fontWeight: "bold" }}>工具栏</span>
                            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                                <span style={{ fontSize: "10px", color: "rgba(255,255,255,0.4)" }}>比例</span>
                                <select 
                                    value={aspectRatio}
                                    onChange={(e) => { setAspectRatio(e.target.value); updateActiveFrame({ aspectRatio: e.target.value }); }}
                                    style={{ padding: "2px 6px", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "4px", color: "#fff", fontSize: "10px", cursor: "pointer" }}
                                >
                                    <option value="16:9">16:9</option>
                                    <option value="9:16">9:16</option>
                                    <option value="1:1">1:1</option>
                                </select>
                            </div>
                        </div>

                        {/* Player Frame Viewport */}
                        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", position: "relative", padding: "16px", background: "#040507" }}>
                            
                            {/* Video generating overlay */}
                            {isGeneratingSingle && (
                                <div style={{ position: "absolute", zIndex: 10, background: "rgba(6,7,10,0.85)", width: "100%", height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "10px" }}>
                                    <div className="w-8 h-8 border-4 border-purple-500 border-t-transparent rounded-full animate-spin"></div>
                                    <span style={{ fontSize: "12px", color: "#fff", fontWeight: "bold" }}>AI 正在融合画风并渲染镜头视频...</span>
                                    <div style={{ width: "200px", height: "4px", background: "rgba(255,255,255,0.1)", borderRadius: "2px", overflow: "hidden" }}>
                                        <div style={{ width: `${singleProgress}%`, height: "100%", background: "#8b5cf6", transition: "width 0.2s" }}></div>
                                    </div>
                                    <span style={{ fontSize: "10px", color: "rgba(255,255,255,0.4)" }}>进度: {singleProgress}%</span>
                                </div>
                            )}

                            {/* Viewport Frame */}
                            <div style={{ 
                                width: "100%", 
                                height: "100%", 
                                maxWidth: aspectRatio === "16:9" ? "560px" : aspectRatio === "9:16" ? "240px" : "340px",
                                maxHeight: "315px",
                                aspectRatio: aspectRatio === "16:9" ? "16/9" : aspectRatio === "9:16" ? "9/16" : "1/1",
                                background: "#0c0d11", 
                                borderRadius: "8px", 
                                border: "1px solid rgba(255,255,255,0.06)",
                                position: "relative",
                                overflow: "hidden",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                boxShadow: "0 10px 30px rgba(0,0,0,0.5)"
                            }}>
                                {activeFrame.videoGenerated && activeFrame.videoUrl ? (
                                    isPlaying ? (
                                        <video 
                                            src={activeFrame.videoUrl} 
                                            autoPlay 
                                            loop 
                                            controls={false}
                                            style={{ width: "100%", height: "100%", objectFit: "cover" }} 
                                        />
                                    ) : (
                                        <>
                                            <img src={activeFrame.image} style={{ width: "100%", height: "100%", objectFit: "cover", filter: "brightness(0.6)" }} />
                                            <button 
                                                onClick={() => setIsPlaying(true)}
                                                style={{ position: "absolute", width: "44px", height: "44px", borderRadius: "50%", background: "rgba(139, 92, 246, 0.9)", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", transition: "transform 0.2s", boxShadow: "0 0 12px rgba(139,92,246,0.5)" }}
                                                className="hover:scale-110"
                                            >
                                                <Play className="h-5 w-5 fill-current ml-0.5" />
                                            </button>
                                        </>
                                    )
                                ) : activeFrame.image ? (
                                    <>
                                        <img src={activeFrame.image} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                                        <div style={{ position: "absolute", bottom: "10px", left: "10px", background: "rgba(0,0,0,0.6)", padding: "3px 8px", borderRadius: "4px", fontSize: "10px", border: "1px solid rgba(255,255,255,0.05)" }}>尚未生成分镜视频</div>
                                    </>
                                ) : (
                                    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "8px", opacity: 0.35 }}>
                                        <Video className="h-8 w-8 text-purple-400" />
                                        <span style={{ fontSize: "11px", fontWeight: "bold" }}>空镜头</span>
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* Player control buttons */}
                        <div style={{ padding: "6px 14px", borderTop: "1px solid rgba(255,255,255,0.04)", display: "flex", alignItems: "center", justifyContent: "center", gap: "16px", background: "#07080a" }}>
                            <button 
                                onClick={() => {
                                    const prevId = Math.max(1, activeFrameId - 1);
                                    handleSelectFrame(prevId);
                                }}
                                style={{ border: "none", background: "transparent", color: "rgba(255,255,255,0.5)", cursor: "pointer" }}
                                className="hover:text-white"
                            >
                                <ChevronLeft className="h-4 w-4" />
                            </button>
                            
                            <button 
                                onClick={() => setIsPlaying(!isPlaying)}
                                disabled={!activeFrame.videoGenerated}
                                style={{ border: "none", background: activeFrame.videoGenerated ? "rgba(255,255,255,0.05)" : "rgba(255,255,255,0.02)", width: "30px", height: "30px", borderRadius: "50%", color: activeFrame.videoGenerated ? "#fff" : "rgba(255,255,255,0.2)", cursor: activeFrame.videoGenerated ? "pointer" : "not-allowed", display: "flex", alignItems: "center", justifyContent: "center" }}
                            >
                                {isPlaying ? <Pause className="h-3.5 w-3.5 fill-current" /> : <Play className="h-3.5 w-3.5 fill-current ml-0.5" />}
                            </button>
                            
                            <button 
                                onClick={() => {
                                    const nextId = Math.min(frames.length, activeFrameId + 1);
                                    handleSelectFrame(nextId);
                                }}
                                style={{ border: "none", background: "transparent", color: "rgba(255,255,255,0.5)", cursor: "pointer" }}
                                className="hover:text-white"
                            >
                                <ChevronRight className="h-4 w-4" />
                            </button>
                            
                            <span style={{ fontSize: "10px", color: "rgba(255,255,255,0.4)", fontFamily: "monospace", minWidth: "75px" }}>
                                {isPlaying ? "00:02.00" : "00:00.00"} / {durationVal.includes("s") ? durationVal.replace("s", ".00") : durationVal.replace(" 秒", ".00")}
                            </span>

                            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "6px" }}>
                                <select 
                                    value={playerZoom}
                                    onChange={(e) => setPlayerZoom(e.target.value)}
                                    style={{ padding: "2px 5px", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "4px", color: "#fff", fontSize: "10px", cursor: "pointer" }}
                                >
                                    <option value="适应">适应</option>
                                    <option value="50%">50%</option>
                                    <option value="100%">100%</option>
                                    <option value="150%">150%</option>
                                </select>
                                <button style={{ border: "none", background: "transparent", color: "rgba(255,255,255,0.5)", cursor: "pointer" }} className="hover:text-white">
                                    <Maximize2 className="h-3.5 w-3.5" />
                                </button>
                            </div>
                        </div>
                    </div>

                    {/* Top Right Half: Asset Library Area */}
                    <div style={{ width: "400px", flexShrink: 0, borderLeft: "1px solid rgba(255,255,255,0.07)", display: "flex", flexDirection: "column", background: "#090a0f" }}>
                        
                        {/* Tab header buttons */}
                        <div style={{ padding: "10px 12px 0 12px", borderBottom: "1px solid rgba(255,255,255,0.04)", display: "flex", flexDirection: "column", gap: "8px", background: "#0b0c10" }}>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                <span style={{ fontSize: "11px", fontWeight: "bold", color: "#fff", display: "flex", alignItems: "center", gap: "5px" }}>
                                    素材区 <span style={{ fontSize: "9px", background: "rgba(139, 92, 246, 0.15)", color: "#a78bfa", padding: "1px 6px", borderRadius: "4px" }}>当前分镜 {activeFrame.shotNumber}</span>
                                </span>
                                <div style={{ display: "flex", gap: "5px" }}>
                                    <button style={{ border: "none", background: "transparent", color: "rgba(255,255,255,0.5)", fontSize: "10px", cursor: "pointer" }} title="上传素材">上传素材</button>
                                    <span style={{ color: "rgba(255,255,255,0.15)", fontSize: "10px" }}>|</span>
                                    <button style={{ border: "none", background: "transparent", color: "rgba(255,255,255,0.5)", fontSize: "10px", cursor: "pointer" }}>声音</button>
                                    <span style={{ color: "rgba(255,255,255,0.15)", fontSize: "10px" }}>|</span>
                                    <button style={{ border: "none", background: "transparent", color: "rgba(255,255,255,0.5)", fontSize: "10px", cursor: "pointer" }}>克隆</button>
                                </div>
                            </div>

                            {/* Tabs triggers */}
                            <div style={{ display: "flex", gap: "10px", overflowX: "auto", paddingBottom: "2px" }} className="qiji-scroll-container">
                                {([
                                    { id: "storyboard", label: "分镜素材" },
                                    { id: "local", label: "本地素材" },
                                    { id: "favorite", label: "收藏素材" },
                                    { id: "history", label: "配置历史" },
                                    { id: "drafts", label: "草稿箱" }
                                ] as const).map(tab => (
                                    <button
                                        key={tab.id}
                                        onClick={() => setAssetTab(tab.id)}
                                        style={{ 
                                            padding: "6px 2px", 
                                            fontSize: "11px", 
                                            fontWeight: assetTab === tab.id ? "bold" : "normal",
                                            color: assetTab === tab.id ? "#8b5cf6" : "rgba(255,255,255,0.45)",
                                            border: "none",
                                            borderBottom: assetTab === tab.id ? "2px solid #8b5cf6" : "2px solid transparent",
                                            background: "transparent",
                                            cursor: "pointer",
                                            whiteSpace: "nowrap"
                                        }}
                                    >
                                        {tab.label}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Search + filter bar */}
                        <div style={{ padding: "8px 12px", display: "flex", gap: "6px", borderBottom: "1px solid rgba(255,255,255,0.03)", background: "#08090d" }}>
                            <div style={{ flex: 1, display: "flex", alignItems: "center", background: "rgba(255,255,255,0.04)", borderRadius: "4px", padding: "0 6px", border: "1px solid rgba(255,255,255,0.06)" }}>
                                <Search className="h-3 w-3 opacity-40 mr-1.5" />
                                <input 
                                    type="text" 
                                    placeholder="按检索条件查询描述..." 
                                    value={searchQuery}
                                    onChange={(e) => setSearchQuery(e.target.value)}
                                    style={{ width: "100%", background: "transparent", border: "none", outline: "none", color: "#fff", fontSize: "10px", padding: "4px 0" }}
                                />
                            </div>
                            <button style={{ padding: "4px 8px", background: "rgba(139, 92, 246, 0.12)", border: "1px solid rgba(139, 92, 246, 0.2)", color: "#c084fc", borderRadius: "4px", fontSize: "10px", display: "flex", alignItems: "center", gap: "3px", cursor: "pointer" }}>
                                <Upload className="h-3 w-3" /> 上传
                            </button>
                        </div>

                        {/* Library Content Panel */}
                        <div className="qiji-scroll-container" style={{ flex: 1, overflowY: "auto", padding: "12px", background: "#07080a" }}>
                            
                            {assetTab === "storyboard" && (
                                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: "8px", opacity: 0.4, padding: "20px 0" }}>
                                    <div style={{ width: "48px", height: "48px", borderRadius: "50%", background: "rgba(255,255,255,0.02)", display: "flex", alignItems: "center", justifyContent: "center", border: "1px dashed rgba(255,255,255,0.1)" }}>
                                        <ImageIcon className="h-5 w-5 text-purple-400" />
                                    </div>
                                    <span style={{ fontSize: "11px", fontWeight: "bold" }}>暂无素材</span>
                                    <span style={{ fontSize: "10px", textAlign: "center", maxWidth: "240px", lineHeight: "1.4" }}>
                                        可通过 AI 生成、裁剪视频 / 或 拖拽文件到此处 / 或点击上方「上传素材」按钮
                                    </span>
                                </div>
                            )}

                            {assetTab === "local" && (
                                <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "8px" }}>
                                    {localAssets.map((asset) => (
                                        <div 
                                            key={asset.id} 
                                            className="qiji-asset-grid-card"
                                            onClick={() => {
                                                // Load as active frame reference image
                                                updateActiveFrame({ image: asset.url });
                                            }}
                                        >
                                            <div style={{ height: "70px", background: "#12141a", position: "relative" }}>
                                                <img src={asset.url} alt={asset.title} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                                                <span style={{ position: "absolute", bottom: "4px", right: "4px", background: "rgba(0,0,0,0.6)", padding: "1px 4px", borderRadius: "3px", fontSize: "8px", color: "#a78bfa" }}>
                                                    加载至分镜
                                                </span>
                                            </div>
                                            <div style={{ padding: "5px" }}>
                                                <div style={{ fontSize: "10px", fontWeight: "bold", textOverflow: "ellipsis", overflow: "hidden", whiteSpace: "nowrap" }}>{asset.title}</div>
                                                <div style={{ fontSize: "8px", opacity: 0.4 }}>本地库图文</div>
                                            </div>
                                        </div>
                                    ))}
                                    <div style={{ 
                                        height: "95px", 
                                        borderRadius: "6px", 
                                        background: "rgba(255,255,255,0.01)", 
                                        border: "1px dashed rgba(255,255,255,0.12)", 
                                        display: "flex", 
                                        flexDirection: "column", 
                                        alignItems: "center", 
                                        justifyContent: "center", 
                                        cursor: "pointer", 
                                        gap: "4px" 
                                    }}>
                                        <Plus className="h-4 w-4 text-purple-400" />
                                        <span style={{ fontSize: "9px", opacity: 0.5 }}>上传新素材</span>
                                    </div>
                                </div>
                            )}

                            {assetTab === "favorite" && (
                                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", opacity: 0.3 }}>
                                    <span style={{ fontSize: "10px" }}>暂无收藏的素材或微动视频</span>
                                </div>
                            )}

                            {assetTab === "history" && (
                                <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                                    {frames.filter(f => f.videoGenerated).map(f => (
                                        <div key={f.id} style={{ display: "flex", gap: "8px", padding: "6px", background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.04)", borderRadius: "4px" }}>
                                            <img src={f.image} style={{ width: "45px", height: "30px", objectFit: "cover", borderRadius: "2px" }} />
                                            <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center" }}>
                                                <span style={{ fontSize: "9px", fontWeight: "bold" }}>镜头 {f.shotNumber} 渲染记录</span>
                                                <span style={{ fontSize: "8px", opacity: 0.4 }}>已保存于 {f.duration} 秒配置内</span>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}

                            {assetTab === "drafts" && (
                                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", opacity: 0.3 }}>
                                    <span style={{ fontSize: "10px" }}>草稿箱空无一物</span>
                                </div>
                            )}

                        </div>
                    </div>
                </div>

                {/* Bottom Half: Storyboard Timeline Sequence Track */}
                <div style={{ flex: 2.2, display: "flex", flexDirection: "column", background: "#07080a", overflow: "hidden" }}>
                    {/* Header bar of Timeline */}
                    <div style={{ padding: "8px 14px", borderBottom: "1px solid rgba(255,255,255,0.05)", display: "flex", justifyContent: "space-between", alignItems: "center", background: "#0b0c10" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                            <span style={{ fontSize: "12px", fontWeight: "bold", color: "#fff" }}>分镜轴 ({frames.length} 个镜头)</span>
                            <span style={{ fontSize: "10px", color: "rgba(255,255,255,0.4)" }}>
                                总时长: {frames.reduce((sum, f) => sum + parseFloat(f.duration), 0).toFixed(0)} 秒
                            </span>
                            
                            {isGeneratingAll && (
                                <div style={{ display: "flex", alignItems: "center", gap: "6px", marginLeft: "10px" }}>
                                    <div style={{ width: "60px", height: "3px", background: "rgba(255,255,255,0.1)", borderRadius: "2px", overflow: "hidden" }}>
                                        <div style={{ width: `${allProgress}%`, height: "100%", background: "#8b5cf6" }}></div>
                                    </div>
                                    <span style={{ fontSize: "8px", color: "#a78bfa" }}>全片渲染中 {allProgress}%</span>
                                </div>
                            )}
                        </div>
                        
                        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                            <button style={{ padding: "4px 8px", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#fff", borderRadius: "4px", fontSize: "10px", cursor: "pointer" }}>一键重新布局</button>
                            <button 
                                onClick={handleGenerateAll}
                                disabled={isGeneratingAll}
                                style={{ padding: "4px 10px", background: isGeneratingAll ? "rgba(139, 92, 246, 0.4)" : "linear-gradient(135deg, #7c3aed, #ec4899)", border: "none", color: "#fff", borderRadius: "4px", fontSize: "10px", fontWeight: "bold", cursor: isGeneratingAll ? "not-allowed" : "pointer", display: "flex", alignItems: "center", gap: "3px" }}
                            >
                                <Sparkles className="h-3 w-3" />
                                {isGeneratingAll ? "生成中..." : "生成全片分镜"}
                            </button>
                        </div>
                    </div>

                    {/* Timeline Track with flanking navigation arrows */}
                    <div style={{ flex: 1, display: "flex", flexDirection: "row", alignItems: "center", position: "relative", padding: "0 10px" }}>
                        
                        {/* Scroll Left Arrow */}
                        <button 
                            onClick={() => scrollTimeline("left")}
                            style={{ position: "absolute", left: "4px", zIndex: 5, width: "22px", height: "22px", borderRadius: "50%", background: "rgba(0,0,0,0.6)", border: "1px solid rgba(255,255,255,0.1)", color: "#fff", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
                            className="hover:bg-purple-900"
                        >
                            <ChevronLeft className="h-3.5 w-3.5" />
                        </button>

                        {/* Scroll container */}
                        <div 
                            ref={timelineContainerRef}
                            className="qiji-scroll-container" 
                            style={{ flex: 1, overflowX: "auto", display: "flex", flexDirection: "row", padding: "10px 15px", gap: "10px", alignItems: "stretch", height: "100%" }}
                        >
                            {frames.map((frame, index) => {
                                const isActive = frame.id === activeFrameId;
                                return (
                                    <div 
                                        key={frame.id}
                                        onClick={() => handleSelectFrame(frame.id)}
                                        className={`qiji-timeline-card ${isActive ? "active" : ""}`}
                                    >
                                        {/* Card Header row */}
                                        <div style={{ padding: "4px 8px", background: "rgba(0,0,0,0.15)", borderBottom: "1px solid rgba(255,255,255,0.04)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                            <span style={{ fontSize: "9px", fontWeight: "bold", color: "#a78bfa", textOverflow: "ellipsis", overflow: "hidden", whiteSpace: "nowrap", maxWidth: "160px" }}>
                                                {frame.shotNumber} {frame.title || "自定义镜头"}
                                            </span>
                                            <span style={{ fontSize: "8px", opacity: 0.3, fontFamily: "monospace" }}>#{index + 1}</span>
                                        </div>

                                        {/* Shot Image Preview */}
                                        <div style={{ height: "65px", background: "#0c0d11", position: "relative", display: "flex", alignItems: "center", justifyContent: "center" }}>
                                            {frame.image ? (
                                                <img src={frame.image} alt={frame.shotNumber} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                                            ) : (
                                                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "3px", opacity: 0.25 }}>
                                                    <ImageIcon className="h-4 w-4" />
                                                    <span style={{ fontSize: "8px" }}>空镜头</span>
                                                </div>
                                            )}
                                            
                                            {/* Top badges */}
                                            <div style={{ position: "absolute", bottom: "4px", left: "4px", padding: "1px 4px", background: "rgba(0,0,0,0.6)", borderRadius: "3px", fontSize: "8px", color: "rgba(255,255,255,0.7)" }}>
                                                {frame.duration}
                                            </div>
                                            <div style={{ position: "absolute", bottom: "4px", right: "4px", padding: "1px 4px", background: frame.videoGenerated ? "#22c55e" : "#8b5cf6", borderRadius: "3px", fontSize: "7px", fontWeight: "500", color: "#fff" }}>
                                                {frame.videoGenerated ? "已生成视频" : "AI 分镜"}
                                            </div>
                                        </div>

                                        {/* Description */}
                                        <div style={{ padding: "6px", flex: 1, display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
                                            <p style={{ fontSize: "10px", margin: 0, lineClamp: 2, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", lineHeight: "1.35", opacity: 0.8, color: "#abb2bf" }}>
                                                {frame.description}
                                            </p>
                                        </div>
                                    </div>
                                );
                            })}

                            {/* Add new frame card button */}
                            <div 
                                style={{
                                    minWidth: "90px",
                                    width: "90px",
                                    border: "1px dashed rgba(255,255,255,0.12)",
                                    borderRadius: "6px",
                                    display: "flex",
                                    flexDirection: "column",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    cursor: "pointer",
                                    gap: "6px",
                                    background: "rgba(255,255,255,0.01)",
                                    transition: "all 0.2s"
                                }}
                                className="hover:bg-white/5 hover:border-purple-500/50"
                                onClick={() => {
                                    const newId = frames.length + 1;
                                    const newFrame: StoryboardFrame = {
                                        id: newId,
                                        shotNumber: `1-${newId}`,
                                        title: `新增分镜镜头`,
                                        type: "中景 (Medium Shot)",
                                        description: "新镜头的画风及视听细节描述...",
                                        cameraMovement: "慢速平移 (Pan)",
                                        duration: "15s",
                                        videoGenerated: false,
                                        model: "Seedance 2.0 Pro",
                                        resolution: "720p",
                                        aspectRatio: "16:9"
                                    };
                                    setFrames([...frames, newFrame]);
                                    handleSelectFrame(newId);
                                    
                                    // Scroll to the end
                                    setTimeout(() => {
                                        if (timelineContainerRef.current) {
                                            timelineContainerRef.current.scrollLeft = timelineContainerRef.current.scrollWidth;
                                        }
                                    }, 100);
                                }}
                            >
                                <Plus className="h-4.5 w-4.5 text-purple-400" />
                                <span style={{ fontSize: "10px", opacity: 0.5 }}>添加分镜</span>
                            </div>
                        </div>

                        {/* Scroll Right Arrow */}
                        <button 
                            onClick={() => scrollTimeline("right")}
                            style={{ position: "absolute", right: "4px", zIndex: 5, width: "22px", height: "22px", borderRadius: "50%", background: "rgba(0,0,0,0.6)", border: "1px solid rgba(255,255,255,0.1)", color: "#fff", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
                            className="hover:bg-purple-900"
                        >
                            <ChevronRight className="h-3.5 w-3.5" />
                        </button>

                    </div>
                </div>

            </div>
        </div>
    );
};

export default FrameStoryboard;

