import EditorHeader from "@/components/EditorHeader";
import EditorSidebar from "@/components/EditorSidebar";
import AssetWorkbench from "@/components/AssetWorkbench";
import "@/styles/Frame16285.css";

// 角色资产工作台（5 区布局：导航/角色列表/造型分体/提示词/图片展示）。
// 布局与交互由共享组件 AssetWorkbench 实现，其余资产页（场景/群像/生物/物品）确认后复用。
const Frame16285 = () => {
    return (
        <div className="scroll-container">
            <div id="16_285" className="Pixso-frame-16_285">
                <EditorHeader title="角色配置" showAssetCheck />
                <div id="16_309" className="Pixso-frame-16_309">
                    <div className="frame-content-16_309" style={{ display: "flex", height: "100%" }}>
                        <EditorSidebar activeTab="角色" />
                        <AssetWorkbench cat="characters" unit="角色" imagePurpose="asset.character.image" textField="features" showVoice />
                    </div>
                </div>
            </div>
        </div>
    );
};

export default Frame16285;
