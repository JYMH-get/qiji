import EditorHeader from "@/components/EditorHeader";
import EditorSidebar from "@/components/EditorSidebar";
import AssetWorkbench from "@/components/AssetWorkbench";
import "@/styles/Frame16285.css";

// 生物资产工作台（5 区布局，复用共享组件 AssetWorkbench）
const Frame16780 = () => {
    return (
        <div className="scroll-container">
            <div id="16_285" className="Pixso-frame-16_285">
                <EditorHeader title="生物配置" />
                <div id="16_309" className="Pixso-frame-16_309">
                    <div className="frame-content-16_309" style={{ display: "flex", height: "100%" }}>
                        <EditorSidebar activeTab="生物" />
                        <AssetWorkbench cat="organisms" unit="生物" imagePurpose="asset.creature.image" textField="description" />
                    </div>
                </div>
            </div>
        </div>
    );
};

export default Frame16780;
