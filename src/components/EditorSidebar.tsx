import { useNavigate } from "react-router";
import { useUiStore } from "@/store/uiStore";

interface EditorSidebarProps {
    activeTab: "剧本" | "角色" | "场景" | "生物" | "物品" | "视频" | "分镜" | "画布";
}

const EditorSidebar = ({ activeTab }: EditorSidebarProps) => {
    const navigate = useNavigate();

    // Helper to get active classes
    const getTabClasses = (tabName: string) => {
        const isActive = activeTab === tabName;
        return {
            container: isActive ? "Pixso-frame-16_131 active" : "Pixso-frame-16_139",
            text: isActive ? "Pixso-paragraph-16_138" : "Pixso-paragraph-16_143"
        };
    };

    return (
        <div id="16_124" className="stroke-wrapper-16_124">
            <div className="Pixso-frame-16_124" style={{ height: "100%" }}>
                <div className="frame-content-16_124">
                    {/* Settings Option */}
                    <div
                        id="16_125"
                        className="Pixso-frame-16_125 cursor-pointer hover:bg-white/5 transition-colors"
                        onClick={() => useUiStore.getState().setProjectSettingsOpen(true)}
                        style={{ cursor: "pointer" }}
                    >
                        <div className="frame-content-16_125">
                            <div id="16_126" className="Pixso-frame-16_126">
                                <div id="16_127" className="stroke-wrapper-16_127">
                                    <div className="Pixso-rectangle-16_127"></div>
                                    <div className="stroke-16_127"></div>
                                </div>
                                <div id="16_128" className="stroke-wrapper-16_128">
                                    <div className="Pixso-rectangle-16_128"></div>
                                    <div className="stroke-16_128"></div>
                                </div>
                                <div id="16_129" className="stroke-wrapper-16_129">
                                    <div className="Pixso-rectangle-16_129"></div>
                                    <div className="stroke-16_129"></div>
                                </div>
                            </div>
                            <p id="16_130" className="Pixso-paragraph-16_130">{"设置"}</p>
                        </div>
                    </div>

                    {/* 1. 剧本 */}
                    <div
                        id="16_131"
                        className={getTabClasses("剧本").container}
                        onClick={() => navigate("/frame1693")}
                        style={{ cursor: "pointer" }}
                    >
                        <div className="frame-content-16_131">
                            <div id="16_132" className="Pixso-vector-16_132"></div>
                            <p id="16_138" className={getTabClasses("剧本").text}>{"剧本"}</p>
                        </div>
                    </div>

                    {/* 2. 角色 */}
                    <div
                        id="16_139"
                        className={getTabClasses("角色").container}
                        onClick={() => navigate("/frame16285")}
                        style={{ cursor: "pointer" }}
                    >
                        <div className="frame-content-16_139">
                            <div id="16_140" className="Pixso-vector-16_140"></div>
                            <p id="16_143" className={getTabClasses("角色").text}>{"角色"}</p>
                        </div>
                    </div>

                    {/* 3. 场景 */}
                    <div
                        id="16_144"
                        className={getTabClasses("场景").container}
                        onClick={() => navigate("/frame16550")}
                        style={{ cursor: "pointer" }}
                    >
                        <div className="frame-content-16_144">
                            <div id="16_145" className="Pixso-vector-16_145"></div>
                            <p id="16_148" className={getTabClasses("场景").text}>{"场景"}</p>
                        </div>
                    </div>

                    {/* 4. 生物 */}
                    <div
                        id="16_149"
                        className={getTabClasses("生物").container}
                        onClick={() => navigate("/frame16780")}
                        style={{ cursor: "pointer" }}
                    >
                        <div className="frame-content-16_149">
                            <div id="16_150" className="Pixso-vector-16_150"></div>
                            <p id="16_162" className={getTabClasses("生物").text}>{"生物"}</p>
                        </div>
                    </div>

                    {/* 5. 物品 */}
                    <div
                        id="16_163"
                        className={getTabClasses("物品").container}
                        onClick={() => navigate("/frame161000")}
                        style={{ cursor: "pointer" }}
                    >
                        <div className="frame-content-16_163">
                            <div id="16_164" className="Pixso-vector-16_164"></div>
                            <p id="16_169" className={getTabClasses("物品").text}>{"物品"}</p>
                        </div>
                    </div>

                    {/* 6. 视频 */}
                    <div
                        id="16_170"
                        className={getTabClasses("视频").container}
                        onClick={() => navigate("/frame161195")}
                        style={{ cursor: "pointer" }}
                    >
                        <div className="frame-content-16_170">
                            <div id="16_171" className="Pixso-frame-16_171">
                                <div id="16_172" className="Pixso-vector-16_172"></div>
                                <div id="16_173" className="stroke-wrapper-16_173">
                                    <div className="Pixso-rectangle-16_173"></div>
                                    <div className="stroke-16_173"></div>
                                </div>
                            </div>
                            <p id="16_174" className={getTabClasses("视频").text}>{"视频"}</p>
                        </div>
                    </div>

                    {/* 7. 分镜 */}
                    <div
                        className={getTabClasses("分镜").container}
                        onClick={() => navigate("/frame-storyboard")}
                        style={{ cursor: "pointer" }}
                    >
                        <div className="frame-content-16_139">
                            <div className="Pixso-vector-16_132" style={{ backgroundImage: "url(@/assets/images/listordered.svg)" }}></div>
                            <p className={getTabClasses("分镜").text}>{"分镜"}</p>
                        </div>
                    </div>

                    {/* 8. 画布 */}
                    <div
                        className={getTabClasses("画布").container}
                        onClick={() => navigate("/frame-canvas")}
                        style={{ cursor: "pointer" }}
                    >
                        <div className="frame-content-16_139">
                            <div className="Pixso-vector-16_132" style={{ backgroundImage: "url(@/assets/images/zap.svg)" }}></div>
                            <p className={getTabClasses("画布").text}>{"画布"}</p>
                        </div>
                    </div>
                </div>
            </div>
            <div className="stroke-16_124"></div>
        </div>
    );
};

export default EditorSidebar;
