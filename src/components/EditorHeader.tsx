import { useNavigate } from "react-router";
import { useSettingsStore } from "@/store/settingsStore";
import { useProjectStore } from "@/store/projectStore";

interface EditorHeaderProps {
    title: string;
    infoLabels?: string[];
}

const EditorHeader = ({ title, infoLabels = [] }: EditorHeaderProps) => {
    const navigate = useNavigate();
    const theme = useSettingsStore((s) => s.theme);
    const setTheme = useSettingsStore((s) => s.setTheme);
    const projectName = useProjectStore((s) => s.name);

    const toggleTheme = () => {
        const newTheme = theme === "dark" ? "light" : "dark";
        setTheme(newTheme);
        if (newTheme === "dark") {
            document.body.classList.add("dark");
        } else {
            document.body.classList.remove("dark");
        }
    };

    return (
        <div id="16_94" className="stroke-wrapper-16_94">
            <div className="Pixso-frame-16_94">
                <div className="frame-content-16_94">
                    <div id="16_95" className="Pixso-frame-16_95">
                        <div className="frame-content-16_95">
                            <div
                                id="16_96"
                                className="Pixso-vector-16_96"
                                onClick={() => navigate("/")}
                                style={{ cursor: "pointer" }}
                            ></div>
                            <div id="16_99" className="stroke-wrapper-16_99">
                                <div className="Pixso-frame-16_99">
                                    <div className="frame-content-16_99">
                                        <div id="16_100" className="Pixso-frame-16_100"></div>
                                        <p id="16_101" className="Pixso-paragraph-16_101">
                                            {title}
                                        </p>
                                    </div>
                                </div>
                                <div className="stroke-16_99"></div>
                            </div>
                            <p id="16_102" className="Pixso-paragraph-16_102">
                                {"当前项目:"}
                            </p>
                            <p id="16_103" className="Pixso-paragraph-16_103">
                                {projectName}
                            </p>
                            {infoLabels.map((lbl, idx) => (
                                <p key={idx} className="Pixso-paragraph-16_102" style={{ marginLeft: "12px", borderLeft: "1px solid rgba(156, 163, 175, 0.3)", paddingLeft: "12px" }}>
                                    {lbl}
                                </p>
                            ))}
                        </div>
                    </div>
                    <div id="16_104" className="Pixso-frame-16_104">
                        <div className="frame-content-16_104">
                            <div id="16_105" className="stroke-wrapper-16_105">
                                <div className="Pixso-frame-16_105">
                                    <div className="frame-content-16_105">
                                        <div id="16_106" className="Pixso-vector-16_106"></div>
                                        <p id="16_109" className="Pixso-paragraph-16_109">
                                            {"已同步云端"}
                                        </p>
                                    </div>
                                </div>
                                <div className="stroke-16_105"></div>
                            </div>
                            {/* Theme Toggle Vector Icon */}
                            <div
                                id="16_118"
                                className="Pixso-vector-16_118"
                                onClick={toggleTheme}
                                style={{ cursor: "pointer" }}
                            ></div>
                        </div>
                    </div>
                </div>
            </div>
            <div className="stroke-16_94"></div>
        </div>
    );
};

export default EditorHeader;
