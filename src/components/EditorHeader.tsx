import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { Coins, TrendingUp, ShieldCheck } from "lucide-react";
import { runAssetCheck, allProjectAssetTargets } from "@/services/assetCheck";
import { useSettingsStore } from "@/store/settingsStore";
import { useProjectStore } from "@/store/projectStore";
import { useConnectionStore } from "@/store/connectionStore";
import { useUiStore } from "@/store/uiStore";
import { managedClient } from "@/services/managedClient";

interface EditorHeaderProps {
    title: string;
    infoLabels?: string[];
    /** 资产界面：显示「检查所有资产」按钮（探全项目资产的 OSS 直链、死链自愈） */
    showAssetCheck?: boolean;
}

const EditorHeader = ({ title, infoLabels = [], showAssetCheck = false }: EditorHeaderProps) => {
    const navigate = useNavigate();
    const theme = useSettingsStore((s) => s.theme);
    const setTheme = useSettingsStore((s) => s.setTheme);
    const projectName = useProjectStore((s) => s.name);

    // 积分：余额来自 connectionStore（心跳/兑换刷新），当日消耗来自 /v1/me。
    const credits = useConnectionStore((s) => s.user?.credits ?? 0);
    const setCredits = useConnectionStore((s) => s.setCredits);
    const loggedIn = useConnectionStore((s) => s.loggedIn);
    const openPersonalCenter = useUiStore((s) => s.setPersonalCenterOpen);
    const [dailySpent, setDailySpent] = useState<number | null>(null);

    useEffect(() => {
        if (!loggedIn) return;
        let cancelled = false;
        void managedClient
            .me()
            .then((s) => {
                if (cancelled) return;
                setDailySpent(s.dailySpent);
                setCredits(s.credits);
            })
            .catch(() => {
                /* 静默失败：积分显示降级为余额，不阻塞界面 */
            });
        return () => {
            cancelled = true;
        };
    }, [loggedIn, setCredits]);

    // 「同步到画布」已移至视频界面（Frame161195）的「同步本集到画布」按钮——仅视频界面可触发、且只同步当前分集。

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
                            {/* 积分：剩余 / 今日已用，点击打开个人中心 */}
                            <div
                                onClick={() => openPersonalCenter(true)}
                                title="查看个人中心 / 兑换积分"
                                style={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: "12px",
                                    marginRight: "12px",
                                    padding: "4px 12px",
                                    borderRadius: "8px",
                                    border: "1px solid rgba(156, 163, 175, 0.25)",
                                    fontSize: "12px",
                                    cursor: "pointer",
                                }}
                            >
                                <span style={{ display: "flex", alignItems: "center", gap: "5px", color: "#fbbf24" }}>
                                    <Coins size={14} />
                                    <span style={{ color: "var(--foreground, #e5e7eb)", fontFamily: "monospace" }}>{credits}</span>
                                    <span style={{ color: "rgba(156, 163, 175, 0.9)" }}>剩余</span>
                                </span>
                                <span style={{ display: "flex", alignItems: "center", gap: "5px", color: "#34d399" }}>
                                    <TrendingUp size={14} />
                                    <span style={{ color: "var(--foreground, #e5e7eb)", fontFamily: "monospace" }}>
                                        {dailySpent ?? "—"}
                                    </span>
                                    <span style={{ color: "rgba(156, 163, 175, 0.9)" }}>今日已用</span>
                                </span>
                            </div>
                            {showAssetCheck && (
                                <button
                                    onClick={() => void runAssetCheck(allProjectAssetTargets(), "检查所有资产")}
                                    title="检查本项目全部资产的图（主图/历史/造型）云端（OSS）直链是否正常，死链且本机有本地副本则自动重传修复"
                                    style={{
                                        display: "flex", alignItems: "center", gap: "6px", marginRight: "10px",
                                        padding: "5px 12px", borderRadius: "8px", border: "1px solid rgba(52,211,153,0.35)",
                                        background: "rgba(52,211,153,0.08)", color: "#34d399", fontSize: "12px", cursor: "pointer",
                                    }}
                                >
                                    <ShieldCheck size={14} />
                                    检查所有资产
                                </button>
                            )}
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
                            {/* Theme Toggle Vector Icon（第245轮：项目内工作区恒深色渲染（ThemeBodySync），
                                此开关只改「大厅/新建页」的主题偏好——悬浮说明语义，防被当成失灵） */}
                            <div
                                id="16_118"
                                className="Pixso-vector-16_118"
                                onClick={toggleTheme}
                                style={{ cursor: "pointer" }}
                                title="切换浅色/深色主题（浅色仅作用于大厅与新建项目页；项目内工作区恒为深色）"
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
