import EditorHeader from "@/components/EditorHeader";
import EditorSidebar from "@/components/EditorSidebar";
import AssetWorkbench from "@/components/AssetWorkbench";
import { useProjectStore } from "@/store/projectStore";
import "@/styles/Frame16285.css";

// 场景资产工作台（5 区布局，复用共享组件 AssetWorkbench）
const Frame16550 = () => {
    const visualStyle = useProjectStore((s) => s.visualStyle) || "国漫电影感";
    return (
        <div className="scroll-container">
            <div id="16_285" className="Pixso-frame-16_285">
                <EditorHeader title="场景配置" infoLabels={["默认图片模型: Image-2", `画风: ${visualStyle}`]} />
                <div id="16_309" className="Pixso-frame-16_309">
                    <div className="frame-content-16_309" style={{ display: "flex", height: "100%" }}>
                        <EditorSidebar activeTab="场景" />
                        <AssetWorkbench cat="scenes" unit="场景" imagePurpose="asset.scene.image" textField="description" />
                    </div>
                </div>
            </div>
        </div>
    );
};

export default Frame16550;
