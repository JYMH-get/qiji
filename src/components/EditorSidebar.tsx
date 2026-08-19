import { useNavigate } from "react-router";
import { FileText, User, Users, Image, PawPrint, Package, Video, Settings, UserCircle } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useUiStore } from "@/store/uiStore";

type TabName = "剧本" | "角色" | "群像" | "场景" | "生物" | "物品" | "视频";

interface EditorSidebarProps {
    activeTab: TabName;
}

const ACTIVE = "rgba(139, 92, 246, 1)";   // 紫
const INACTIVE = "rgba(156, 163, 175, 1)"; // 灰

// 表格模式各页签（画布已移至顶部标题栏的「表格/画布」切换）
const TABS: { name: TabName; route: string; icon: LucideIcon }[] = [
    { name: "剧本", route: "/frame1693", icon: FileText },
    { name: "角色", route: "/frame16285", icon: User },
    { name: "群像", route: "/frame-group", icon: Users },
    { name: "场景", route: "/frame16550", icon: Image },
    { name: "生物", route: "/frame16780", icon: PawPrint },
    { name: "物品", route: "/frame161000", icon: Package },
    { name: "视频", route: "/frame161195", icon: Video },
];

const EditorSidebar = ({ activeTab }: EditorSidebarProps) => {
    const navigate = useNavigate();

    // 统一的侧栏按钮：选中=紫（图标+文字+底色），未选中=灰
    const Item = ({ icon: Icon, label, active, onClick }: { icon: LucideIcon; label: string; active: boolean; onClick: () => void }) => (
        <div
            onClick={onClick}
            style={{
                width: 40,
                minHeight: 44,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 3,
                borderRadius: 6,
                cursor: "pointer",
                background: active ? "rgba(139, 92, 246, 0.16)" : "transparent",
                transition: "background 0.15s",
            }}
            onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = "rgba(255,255,255,0.06)"; }}
            onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = "transparent"; }}
        >
            <Icon size={16} color={active ? ACTIVE : INACTIVE} strokeWidth={active ? 2.4 : 2} />
            <span style={{ fontSize: 10, fontWeight: active ? 600 : 400, color: active ? ACTIVE : INACTIVE, whiteSpace: "nowrap" }}>{label}</span>
        </div>
    );

    return (
        <div id="16_124" className="stroke-wrapper-16_124" style={{ alignSelf: "stretch", height: "100%" }}>
            <div className="Pixso-frame-16_124" style={{ height: "100%" }}>
                <div className="frame-content-16_124" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
                    {/* 顶部：表格模式各页签 */}
                    {TABS.map((t) => (
                        <Item
                            key={t.name}
                            icon={t.icon}
                            label={t.name}
                            active={activeTab === t.name}
                            onClick={() => navigate(t.route)}
                        />
                    ))}

                    {/* 底部：设置 + 个人中心（始终非激活态/灰色） */}
                    <div style={{ marginTop: "auto", display: "flex", flexDirection: "column", gap: 4, alignItems: "center", paddingTop: 8 }}>
                        <Item icon={Settings} label="设置" active={false} onClick={() => useUiStore.getState().setSettingsOpen(true)} />
                        <Item icon={UserCircle} label="个人中心" active={false} onClick={() => useUiStore.getState().setPersonalCenterOpen(true)} />
                    </div>
                </div>
            </div>
            <div className="stroke-16_124"></div>
        </div>
    );
};

export default EditorSidebar;
