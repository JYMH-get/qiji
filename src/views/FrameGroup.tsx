import EditorHeader from "@/components/EditorHeader";
import EditorSidebar from "@/components/EditorSidebar";
import AssetWorkbench from "@/components/AssetWorkbench";
import { useProjectStore } from "@/store/projectStore";
import "@/styles/Frame16285.css";

// 群像资产工作台（5 区布局，复用共享组件 AssetWorkbench）。
// 群像属角色类多人立绘，出图复用 asset.character.image；群体无单独音色，不显示音色绑定。
const FrameGroup = () => {
    const visualStyle = useProjectStore((s) => s.visualStyle) || "国漫电影感";
    return (
        <div className="scroll-container">
            <div id="16_285" className="Pixso-frame-16_285">
                <EditorHeader title="群像配置" infoLabels={["默认图片模型: Image-2", `画风: ${visualStyle}`]} />
                <div id="16_309" className="Pixso-frame-16_309">
                    <div className="frame-content-16_309" style={{ display: "flex", height: "100%" }}>
                        <EditorSidebar activeTab="群像" />
                        <AssetWorkbench cat="crowds" unit="群像" imagePurpose="asset.character.image" textField="features" />
                    </div>
                </div>
            </div>
        </div>
    );
};

export default FrameGroup;
