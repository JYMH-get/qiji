import { ReactFlowProvider } from "@xyflow/react";
import { Canvas } from "@/canvas/Canvas";
import { FloatingToolbar } from "@/canvas/FloatingToolbar";
import { AssetPanel } from "@/canvas/AssetPanel";
import { ContextMenu } from "@/canvas/ContextMenu";
import { StatusBar } from "@/canvas/StatusBar";
import { ErrorBoundary } from "@/canvas/ErrorBoundary";
import { AssistantPanel } from "@/canvas/AssistantPanel";
import "@/styles.css"; // Load Canvas styling

const FrameCanvas = () => {
    return (
        <div style={{ width: "100vw", height: "100%", position: "relative", background: "#0a0b0f" }}>
            <ReactFlowProvider>
                <div className="Qiji-canvas" style={{ top: 0, height: "100%" }}>
                    <ErrorBoundary>
                        <Canvas />
                    </ErrorBoundary>
                    <FloatingToolbar />
                    <AssetPanel />
                    <StatusBar />
                    <ContextMenu />
                    <AssistantPanel />
                </div>
            </ReactFlowProvider>
        </div>
    );
};

export default FrameCanvas;
