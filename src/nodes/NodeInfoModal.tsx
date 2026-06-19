/**
 * NodeInfoPopover — 节点信息浮动面板
 * 接收 nodeId prop，渲染在节点正上方
 * 支持「信息」和「JSON」两种视图切换
 */
import { useMemo, useState } from "react";
import { X, Braces, FileText } from "lucide-react";
import { useCanvasStore } from "@/store/canvasStore";
import { useUiStore } from "@/store/uiStore";
import { getPlugin } from "@/nodes/pluginRegistry";

const STATUS_LABEL: Record<string, string> = {
  idle: "待命",
  editing: "编辑中",
  queued: "排队中",
  scheduled: "已排期",
  running: "生成中",
  success: "success",
  failed: "failed",
};

export function NodeInfoPopover() {
  const infoNodeId = useUiStore((s) => s.nodeInfoNodeId);
  const node = useCanvasStore((s) => (infoNodeId ? s.nodes[infoNodeId] : null));
  const runtime = useCanvasStore((s) =>
    infoNodeId ? s.runtime[infoNodeId] : null,
  );
  const [tab, setTab] = useState<"info" | "json">("info");

  const plugin = node ? getPlugin(node.type) : null;
  const status = runtime?.status ?? "idle";

  const params = (node?.data.params ?? {}) as Record<string, any>;
  const prompt = params.prompt ?? params.composerContent ?? "";
  const model = params.model ?? "";
  const generationMode = params.generationMode ?? "";

  const jsonText = useMemo(() => {
    if (!node) return "{}";
    const obj = {
      id: node.id,
      type: node.type,
      position: { x: node.x, y: node.y },
      width: node.w ?? 240,
      height: node.h ?? 200,
      metadata: {
        content: params.content ?? "",
        status,
        generationMode,
        model,
        size: params.size ?? "",
        count: params.quantity ?? params.count ?? 1,
        composerContent: params.composerContent ?? "",
        prompt: params.prompt ?? "",
      },
    };
    return JSON.stringify(obj, null, 2);
  }, [node, params, status, generationMode, model]);

  if (!infoNodeId || !node) return null;

  return (
    <div
      className="fixed inset-0 z-[20000] flex items-center justify-center bg-black/40 backdrop-blur-[2px] animate-in fade-in duration-200"
      onClick={() => useUiStore.getState().setNodeInfoNodeId(null)}
    >
      <div
        className="Qiji-panel flex flex-col w-[400px] max-h-[60vh] rounded-2xl text-foreground shadow-2xl border border-white/10 overflow-hidden animate-in zoom-in-95 duration-150"
        style={{
          background: "rgba(30, 37, 56, 0.98)",
          boxShadow: "0 20px 50px rgba(0, 0, 0, 0.6)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-4 pb-0">
          <h3 className="text-sm font-semibold text-foreground">节点信息</h3>
          <div className="flex items-center gap-3">
            <div className="flex items-center rounded-lg bg-white/5 border border-white/10 overflow-hidden">
              <button
                onClick={() => setTab("info")}
                className={`flex items-center gap-1.5 px-3 py-1 text-[11px] font-medium transition-colors cursor-pointer ${
                  tab === "info"
                    ? "bg-white/10 text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <FileText className="h-3 w-3" />
                信息
              </button>
              <button
                onClick={() => setTab("json")}
                className={`flex items-center gap-1.5 px-3 py-1 text-[11px] font-medium transition-colors cursor-pointer ${
                  tab === "json"
                    ? "bg-white/10 text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Braces className="h-3 w-3" />
                JSON
              </button>
            </div>
            <button
              onClick={() => useUiStore.getState().setNodeInfoNodeId(null)}
              className="text-muted-foreground hover:text-foreground hover:bg-secondary rounded-lg p-1 transition-colors cursor-pointer"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-4 Qiji-scroll-thin">
          {tab === "info" ? (
            <div className="flex flex-col gap-2.5 text-xs">
              <InfoRow label="ID" value={node.id} />
              <InfoRow label="类型" value={plugin?.label ?? node.type} />
              <InfoRow
                label="尺寸"
                value={`${node.w ?? 240} x ${node.h ?? 200}`}
              />
              <InfoRow
                label="位置"
                value={`${Math.round(node.x)}, ${Math.round(node.y)}`}
              />
              <InfoRow label="状态" value={STATUS_LABEL[status] ?? status} />
              {generationMode && (
                <InfoRow label="生成模式" value={generationMode} />
              )}
              {model && <InfoRow label="模型" value={model} />}
              {prompt && <InfoRow label="提示词" value={prompt} />}
            </div>
          ) : (
            <pre className="text-[10px] text-foreground font-mono whitespace-pre-wrap break-all leading-relaxed bg-black/30 rounded-xl p-3 border border-white/5 max-h-[45vh] overflow-y-auto Qiji-scroll-thin">
              {jsonText}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start gap-3">
      <span className="text-muted-foreground shrink-0 w-14 text-right">
        {label}
      </span>
      <span className="text-foreground break-all">{value}</span>
    </div>
  );
}
