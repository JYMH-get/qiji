import { useNavigate } from "react-router";
import { useEffect, useState } from "react";
import { Settings } from "lucide-react";
import { useProjectStore, type RecentProject } from "@/store/projectStore";
import { useSettingsStore } from "@/store/settingsStore";
import { useUiStore } from "@/store/uiStore";
import { withStopPropagation, restoreRouteAfterLoad } from "@/views/utils/utils";
import { ProjectSettingsModal } from "@/components/ProjectSettingsModal";
import "@/styles/Frame21.css";

const Frame21 = () => {
    const navigate = useNavigate();
    const recentProjects = useProjectStore((s) => s.recentProjects);
    const theme = useSettingsStore((s) => s.theme);
    const setTheme = useSettingsStore((s) => s.setTheme);

    const [searchQuery, setSearchQuery] = useState("");
    // 项目设置弹窗（管理界面：改名/封面）当前编辑的项目
    const [settingsProject, setSettingsProject] = useState<RecentProject | null>(null);

    // 启动自动恢复项目后跳到上次停留的页面（快照）。订阅 store 字段而非一次性 window 标志：
    // loadFromPath 异步完成可能晚于本组件挂载，响应式订阅能保证晚到的恢复也会触发跳转。
    const loadedOnStartup = useProjectStore((s) => s.loadedOnStartup);
    useEffect(() => {
        if (loadedOnStartup) {
            useProjectStore.setState({ loadedOnStartup: false });
            // 恢复到上次停留的页面（快照），无快照则默认剧本页
            navigate(restoreRouteAfterLoad());
        }
    }, [loadedOnStartup, navigate]);

    const toggleTheme = () => {
        const newTheme = theme === "dark" ? "light" : "dark";
        setTheme(newTheme);
        if (newTheme === "dark") {
            document.body.classList.add("dark");
        } else {
            document.body.classList.remove("dark");
        }
    };

    const handleEnterProject = async (path: string) => {
        const success = await useProjectStore.getState().loadFromPath(path);
        if (success) {
            // 进入项目后跳到该项目上次停留的页面（快照）
            navigate(restoreRouteAfterLoad());
        }
    };

    // 导入已有项目（.Qiji）：新建项目并复制素材（源项目不动），成功即进入新项目
    const handleImportProject = async () => {
        const ok = await useProjectStore.getState().importProject();
        if (ok) navigate(restoreRouteAfterLoad());
    };

    const handleRemoveRecent = (e: React.MouseEvent, path: string) => {
        e.stopPropagation();
        const list = recentProjects.filter((r) => r.path !== path);
        localStorage.setItem("Qiji:recentProjects", JSON.stringify(list));
        useProjectStore.setState({ recentProjects: list });
    };

    const filteredProjects = recentProjects.filter((p) =>
        p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        p.path.toLowerCase().includes(searchQuery.toLowerCase())
    );

    const click_2_58 = () => {
        navigate("/frame164", {
            state: {
                from: "2:58",
                et: "c"
            }
        });
    };

    const click_2_64 = () => {
        navigate("/frame164", {
            state: {
                from: "2:64",
                et: "c"
            }
        });
    };

    return (
        <div className="scroll-container">
            <div id="2_1" className="Pixso-frame-2_1">
                {/* Sidebar */}
                <div id="2_2" className="stroke-wrapper-2_2">
                    <div className="Pixso-frame-2_2">
                        <div className="frame-content-2_2">
                            <div id="2_3" className="Pixso-frame-2_3">
                                <div className="frame-content-2_3">
                                    <div id="2_4" className="Pixso-vector-2_4"></div>
                                </div>
                            </div>
                            <div id="2_6" className="Pixso-frame-2_6"></div>
                            {/* Dashboard icon (Active) */}
                            <div id="2_7" className="Pixso-frame-2_7">
                                <div className="frame-content-2_7">
                                    <div id="2_8" className="Pixso-frame-2_8">
                                        <div id="2_9" className="stroke-wrapper-2_9">
                                            <div className="Pixso-rectangle-2_9"></div>
                                            <div className="stroke-2_9"></div>
                                        </div>
                                        <div id="2_10" className="stroke-wrapper-2_10">
                                            <div className="Pixso-rectangle-2_10"></div>
                                            <div className="stroke-2_10"></div>
                                        </div>
                                        <div id="2_11" className="stroke-wrapper-2_11">
                                            <div className="Pixso-rectangle-2_11"></div>
                                            <div className="stroke-2_11"></div>
                                        </div>
                                        <div id="2_12" className="stroke-wrapper-2_12">
                                            <div className="Pixso-rectangle-2_12"></div>
                                            <div className="stroke-2_12"></div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                            {/* User details → 个人中心（积分/兑换/请求记录/授权） */}
                            <div
                                id="2_20"
                                className="Pixso-frame-2_20 hover:bg-black/10 dark:hover:bg-white/10"
                                onClick={() => useUiStore.getState().setPersonalCenterOpen(true)}
                                style={{ cursor: "pointer" }}
                                title="个人中心"
                            >
                                <div className="frame-content-2_20">
                                    <div id="2_21" className="Pixso-vector-2_21"></div>
                                </div>
                            </div>
                             {/* Settings / Theme toggle */}
                             <div id="2_44" className="Pixso-frame-2_44">
                                 <div className="frame-content-2_44">
                                     <div
                                         id="sidebar-settings"
                                         className="Pixso-frame-2_151 hover:bg-black/10 dark:hover:bg-white/10"
                                         onClick={() => useUiStore.getState().setSettingsOpen(true)}
                                         style={{ cursor: "pointer" }}
                                         title="全局设置"
                                     >
                                         <div className="frame-content-2_151">
                                             <div
                                                 className="Pixso-vector-2_152"
                                                 style={{ backgroundImage: "url(@/assets/images/settings.svg)" }}
                                             ></div>
                                         </div>
                                     </div>
                                     <div
                                         id="2_151"
                                         className="Pixso-frame-2_151 hover:bg-black/10 dark:hover:bg-white/10"
                                         onClick={toggleTheme}
                                         style={{ cursor: "pointer" }}
                                         title="切换主题"
                                     >
                                         <div className="frame-content-2_151">
                                             <div
                                                 id="2_152"
                                                 className="Pixso-vector-2_152"
                                                 style={{ backgroundImage: "url(@/assets/images/zap.svg)" }}
                                             ></div>
                                         </div>
                                     </div>
                                 </div>
                             </div>
                        </div>
                    </div>
                    <div className="stroke-2_2"></div>
                </div>

                {/* Main Content Area */}
                <div id="2_45" className="Pixso-frame-2_45" style={{ minHeight: "100vh" }}>
                    <div className="frame-content-2_45">
                        <div id="2_46" className="Pixso-frame-2_46">
                            <div className="frame-content-2_46">
                                <div id="2_47" className="stroke-wrapper-2_47">
                                    <div className="Pixso-frame-2_47">
                                        <div className="frame-content-2_47">
                                            <div id="2_48" className="Pixso-vector-2_48"></div>
                                            <input
                                                type="text"
                                                placeholder="搜索项目名称或描述..."
                                                value={searchQuery}
                                                onChange={(e) => setSearchQuery(e.target.value)}
                                                style={{
                                                    background: "transparent",
                                                    border: "none",
                                                    outline: "none",
                                                    width: "100%",
                                                    fontSize: "14px",
                                                    color: theme === "dark" ? "#ffffff" : "#1a1a2e"
                                                }}
                                            />
                                        </div>
                                    </div>
                                    <div className="stroke-2_47"></div>
                                </div>
                                <div id="2_52" className="stroke-wrapper-2_52">
                                    <div className="Pixso-frame-2_52">
                                        <div className="frame-content-2_52">
                                            <p id="2_53" className="Pixso-paragraph-2_53">
                                                {"最近更新"}
                                            </p>
                                            <p id="2_54" className="Pixso-paragraph-2_54">
                                                {"按打开时间倒序排布"}
                                            </p>
                                        </div>
                                    </div>
                                    <div className="stroke-2_52"></div>
                                </div>
                                <p id="2_55" className="Pixso-paragraph-2_55">
                                    {`共 ${recentProjects.length} 个项目  /  当前过滤显示 ${filteredProjects.length} 个`}
                                </p>
                            </div>
                        </div>

                        {/* Project Cards Grid */}
                        <div id="2_56" className="Pixso-frame-2_56">
                            <div className="frame-content-2_56" style={{ display: "flex", flexWrap: "wrap", gap: "20px", height: "auto", overflow: "visible" }}>
                                {/* Static "Create Project" Card（高度放开：底部多一行「导入已有项目」） */}
                                <div id="2_57" className="stroke-wrapper-2_57" style={{ height: "auto", minHeight: 340 }}>
                                    <div className="Pixso-frame-2_57">
                                        <div className="frame-content-2_57">
                                            <div id="2_58" className="stroke-wrapper-2_58">
                                                <div
                                                    className="Pixso-frame-2_58"
                                                    onClick={withStopPropagation(click_2_58)}
                                                    style={{ cursor: "pointer" }}
                                                >
                                                    <div className="frame-content-2_58">
                                                        <div id="2_59" className="Pixso-vector-2_59"></div>
                                                    </div>
                                                </div>
                                                <div className="stroke-2_58"></div>
                                            </div>
                                            <p id="2_62" className="Pixso-paragraph-2_62">
                                                {"创建新项目"}
                                            </p>
                                            <p id="2_63" className="Pixso-paragraph-2_63">
                                                {"开启一次新的灵感编排，支持配置模型与填表"}
                                            </p>
                                            <div id="2_64" className="stroke-wrapper-2_64">
                                                <div
                                                    className="Pixso-frame-2_64"
                                                    onClick={withStopPropagation(click_2_64)}
                                                    style={{ cursor: "pointer" }}
                                                >
                                                    <div className="frame-content-2_64">
                                                        <p id="2_65" className="Pixso-paragraph-2_65">
                                                            {"点击立即开始"}
                                                        </p>
                                                    </div>
                                                </div>
                                                <div className="stroke-2_64"></div>
                                            </div>
                                            {/* 导入已有项目：新建项目并复制素材导入（源项目不动） */}
                                            <div className="stroke-wrapper-2_64">
                                                <div
                                                    className="Pixso-frame-2_64"
                                                    onClick={withStopPropagation(handleImportProject)}
                                                    style={{ cursor: "pointer" }}
                                                    title="选择 .Qiji 项目文件，复制为一个全新项目导入（不影响原项目）"
                                                >
                                                    <div className="frame-content-2_64">
                                                        <p className="Pixso-paragraph-2_65">
                                                            {"导入已有项目 (.Qiji)"}
                                                        </p>
                                                    </div>
                                                </div>
                                                <div className="stroke-2_64" style={{ borderStyle: "dashed" }}></div>
                                            </div>
                                        </div>
                                    </div>
                                    <div className="stroke-2_57"></div>
                                </div>

                                {/* Dynamic Recent Projects Cards */}
                                {filteredProjects.map((proj) => (
                                    <div key={proj.path} id="2_125" className="stroke-wrapper-2_125" style={{ position: "relative" }}>
                                        {/* 项目设置（管理界面：改名/封面）——覆盖在卡片右上角，不触发进入项目 */}
                                        <button
                                            onClick={(e) => { e.stopPropagation(); setSettingsProject(proj); }}
                                            title="项目设置（修改名称 / 封面）"
                                            style={{
                                                position: "absolute", top: 10, right: 10, zIndex: 5,
                                                width: 30, height: 30, borderRadius: 8, border: "none",
                                                background: "rgba(0,0,0,0.45)", color: "#fff", cursor: "pointer",
                                                display: "flex", alignItems: "center", justifyContent: "center",
                                                backdropFilter: "blur(2px)",
                                            }}
                                        >
                                            <Settings size={15} />
                                        </button>
                                        <div
                                            className="Pixso-frame-2_125"
                                            onClick={withStopPropagation(() => handleEnterProject(proj.path))}
                                            style={{ cursor: "pointer" }}
                                        >
                                            <div className="frame-content-2_125">
                                                <div id="2_126" className="Pixso-frame-2_126" style={{ overflow: "hidden", borderRadius: "12px 12px 0 0" }}>
                                                    {proj.cover ? (
                                                        <img
                                                            src={proj.cover}
                                                            alt={proj.name}
                                                            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
                                                        />
                                                    ) : (
                                                        <div id="2_127" className="Pixso-frame-2_127">
                                                            <div id="2_128" className="stroke-wrapper-2_128">
                                                                <div className="Pixso-rectangle-2_128"></div>
                                                                <div className="stroke-2_128"></div>
                                                            </div>
                                                            <div id="2_129" className="Pixso-vector-2_129"></div>
                                                            <div id="2_130" className="Pixso-vector-2_130"></div>
                                                        </div>
                                                    )}
                                                    <div id="2_131" className="Pixso-frame-2_131">
                                                        <div id="2_132" className="stroke-wrapper-2_132">
                                                            <div className="Pixso-frame-2_132">
                                                                <div className="frame-content-2_132">
                                                                    <p id="2_133" className="Pixso-paragraph-2_133">
                                                                        {"灵感项目"}
                                                                    </p>
                                                                </div>
                                                            </div>
                                                            <div className="stroke-2_132"></div>
                                                        </div>
                                                    </div>
                                                </div>
                                                <div id="2_134" className="Pixso-frame-2_134">
                                                    <div className="frame-content-2_134">
                                                        <p id="2_135" className="Pixso-paragraph-2_135" style={{ wordBreak: "break-all" }}>
                                                            {proj.name}
                                                        </p>
                                                        <p id="2_136" className="Pixso-paragraph-2_136" style={{ fontSize: "11px", wordBreak: "break-all", whiteSpace: "normal" }}>
                                                            {proj.path}
                                                        </p>
                                                        <div id="2_137" className="Pixso-frame-2_137">
                                                            <div id="2_138" className="Pixso-frame-2_138"></div>
                                                        </div>
                                                        <p id="2_139" className="Pixso-paragraph-2_139">
                                                            {"记录已在本地激活"}
                                                        </p>
                                                    </div>
                                                </div>
                                                <div id="2_140" className="stroke-wrapper-2_140">
                                                    <div className="Pixso-frame-2_140">
                                                        <div className="frame-content-2_140" style={{ display: "flex", justifyContent: "space-between", width: "100%", padding: "0 12px" }}>
                                                            <div
                                                                id="2_141"
                                                                className="Pixso-frame-2_141"
                                                                onClick={withStopPropagation(() => handleEnterProject(proj.path))}
                                                                style={{ background: "none", border: "none", cursor: "pointer", display: "flex", gap: "4px", padding: 0 }}
                                                            >
                                                                <div id="2_142" className="Pixso-vector-2_142"></div>
                                                                <p id="2_144" className="Pixso-paragraph-2_144" style={{ margin: 0 }}>
                                                                    {"进入项目"}
                                                                </p>
                                                            </div>
                                                            <button
                                                                onClick={(e) => handleRemoveRecent(e, proj.path)}
                                                                style={{ background: "none", border: "none", color: "#ef4444", fontSize: "11px", cursor: "pointer" }}
                                                            >
                                                                {"删除"}
                                                            </button>
                                                        </div>
                                                    </div>
                                                    <div className="stroke-2_140"></div>
                                                </div>
                                            </div>
                                        </div>
                                        <div className="stroke-2_125"></div>
                                    </div>
                                ))}
                            </div>
                        </div>

                        <div id="2_146" className="Pixso-frame-2_146">
                            <div className="frame-content-2_146">
                                <p id="2_147" className="Pixso-paragraph-2_147">
                                    {"已经到底啦"}
                                </p>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {settingsProject && (
                <ProjectSettingsModal
                    project={settingsProject}
                    onClose={() => setSettingsProject(null)}
                />
            )}
        </div>
    );
};

export default Frame21;
