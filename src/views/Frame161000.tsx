import EditorHeader from "@/components/EditorHeader";
import EditorSidebar from "@/components/EditorSidebar";
import AssetWorkbench from "@/components/AssetWorkbench";
import "@/styles/Frame16285.css";

// 物品/道具资产工作台（5 区布局，复用共享组件 AssetWorkbench）
const Frame161000 = () => {
    return (
        <div className="scroll-container">
            <div id="16_285" className="Pixso-frame-16_285">
                <EditorHeader title="道具配置" showAssetCheck />
                <div id="16_309" className="Pixso-frame-16_309">
                    <div className="frame-content-16_309" style={{ display: "flex", height: "100%" }}>
                        <EditorSidebar activeTab="物品" />
                        <AssetWorkbench cat="items" unit="物品" imagePurpose="asset.prop.image" textField="description" />
                    </div>
                </div>
            </div>
        </div>
    );
};

export default Frame161000;
