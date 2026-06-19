/**
 * BlackboxPanel — 全局黑匣子面板
 * 展示所有节点执行的请求/响应日志
 */
import { useState, useEffect } from "react";
import { useUiStore } from "@/store/uiStore";
import { getBlackboxLog, clearBlackbox, type TaskBlackboxRecord } from "@/services/taskBlackbox";
import {
  X,
  RefreshCw,
  Trash2,
  ChevronDown,
  ChevronRight,
  Send,
  ArrowDownLeft,
  AlertTriangle,
  Terminal,
} from "lucide-react";

function JsonBlock({ data, label }: { data: unknown; label?: string }) {
  const [expanded, setExpanded] = useState(false);
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);

  return (
    <div className="mt-1">
      {label && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1 text-[9px] text-muted-foreground hover:text-foreground cursor-pointer"
        >
          {expanded ? <ChevronDown className="h-2.5 w-2.5" /> : <ChevronRight className="h-2.5 w-2.5" />}
          {label}
        </button>
      )}
      {expanded && (
        <pre
          className="mt-0.5 p-2 rounded text-[9px] leading-tight overflow-x-auto whitespace-pre-wrap break-all select-all"
          style={{
            background: "rgba(0,0,0,0.4)",
            border: "1px solid rgba(255,255,255,0.06)",
            color: "var(--foreground)",
            maxHeight: "200px",
          }}
        >
          {text}
        </pre>
      )}
    </div>
  );
}

function RecordCard({ record }: { record: TaskBlackboxRecord }) {
  const [expanded, setExpanded] = useState(false);
  const hasError = !!record.error;

  return (
    <div
      className="rounded-lg overflow-hidden cursor-pointer transition-colors"
      style={{
        background: hasError ? "rgba(239,68,68,0.06)" : "rgba(255,255,255,0.02)",
        border: `1px solid ${hasError ? "rgba(239,68,68,0.2)" : "rgba(255,255,255,0.06)"}`,
      }}
      onClick={() => setExpanded(!expanded)}
    >
      {/* 摘要行 */}
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="inline-block h-2 w-2 rounded-full shrink-0"
            style={{
              background: hasError
                ? "#ef4444"
                : record.response
                  ? record.response.status < 400
                    ? "#22c55e"
                    : "#f59e0b"
                  : "#6b7280",
            }}
          />
          <span className="text-[10px] text-foreground font-medium truncate">
            {record.modelName || record.adapterKey}
          </span>
          <span className="text-[9px] text-muted-foreground font-mono shrink-0">
            {record.nodeType}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {record.response && (
            <span
              className="text-[9px] font-mono"
              style={{
                color: record.response.status < 400 ? "#22c55e" : "#ef4444",
              }}
            >
              {record.response.status}
            </span>
          )}
          {record.response?.durationMs != null && (
            <span className="text-[9px] text-muted-foreground font-mono">
              {record.response.durationMs}ms
            </span>
          )}
          {record.pollCount != null && record.pollCount > 0 && (
            <span className="text-[9px] text-muted-foreground font-mono">
              poll×{record.pollCount}
            </span>
          )}
          <span className="text-[8px] text-muted-foreground">
            {record.startedAt ? new Date(record.startedAt).toLocaleTimeString() : ""}
          </span>
          {expanded ? (
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
          )}
        </div>
      </div>

      {/* 展开详情 */}
      {expanded && (
        <div className="px-3 pb-3 flex flex-col gap-2 border-t border-white/5 pt-2">
          {/* 请求 */}
          {record.request && (
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-1 text-[9px]">
                <Send className="h-2.5 w-2.5 text-blue-400" />
                <span className="text-blue-400 font-medium">请求</span>
                <span className="text-muted-foreground font-mono text-[8px]">{record.request.method}</span>
              </div>
              <div className="text-[9px] text-foreground/80 font-mono break-all">
                {record.request.url}
              </div>
              <JsonBlock data={record.request.body} label="Body" />
            </div>
          )}

          {/* 错误 */}
          {record.error && (
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-1 text-[9px]">
                <AlertTriangle className="h-2.5 w-2.5 text-red-400" />
                <span className="text-red-400 font-medium">错误</span>
              </div>
              <div className="text-[9px] text-red-400/80 break-words leading-tight">
                {record.error.message}
              </div>
            </div>
          )}

          {/* 响应 */}
          {record.response && (
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-1 text-[9px]">
                <ArrowDownLeft className="h-2.5 w-2.5 text-emerald-400" />
                <span className="text-emerald-400 font-medium">响应</span>
                <span className="text-[9px] font-mono" style={{ color: record.response.status < 400 ? "#22c55e" : "#ef4444" }}>
                  {record.response.status} {record.response.statusText}
                </span>
                <span className="text-muted-foreground text-[8px]">{record.response.durationMs}ms</span>
              </div>
              <JsonBlock data={record.response.body} label="Body" />
            </div>
          )}

          {/* 轮询 */}
          {record.pollCount != null && record.pollCount > 0 && (
            <div className="flex flex-col gap-0.5">
              <div className="text-[9px] text-muted-foreground">
                轮询 {record.pollCount} 次
              </div>
              {record.pollHistory && record.pollHistory.length > 0 && (
                <div className="text-[8px] text-muted-foreground/70">
                  最新: {record.pollHistory[record.pollHistory.length - 1].status} ({record.pollHistory[record.pollHistory.length - 1].progress}%)
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function BlackboxPanel() {
  const blackboxOpen = useUiStore((s) => s.blackboxOpen);
  const setBlackboxOpen = useUiStore((s) => s.setBlackboxOpen);
  const [records, setRecords] = useState<TaskBlackboxRecord[]>([]);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!blackboxOpen) return;
    const timer = setInterval(() => setTick((t) => t + 1), 2000);
    return () => clearInterval(timer);
  }, [blackboxOpen]);

  useEffect(() => {
    if (blackboxOpen) {
      setRecords(getBlackboxLog());
    }
  }, [blackboxOpen, tick]);

  if (!blackboxOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[20000] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={() => setBlackboxOpen(false)}
    >
      <div
        className="Qiji-panel flex flex-col w-[640px] max-h-[80vh] rounded-2xl text-foreground shadow-2xl border border-white/10 overflow-hidden"
        style={{ border: "1px solid rgba(255, 255, 255, 0.1)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-4 pb-3">
          <div className="flex items-center gap-2">
            <Terminal className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold text-foreground">任务黑匣子</h3>
            <span className="text-[10px] text-muted-foreground">({records.length})</span>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setRecords(getBlackboxLog())}
              className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors cursor-pointer"
              title="刷新"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => { clearBlackbox(); setRecords([]); }}
              className="p-1.5 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors cursor-pointer"
              title="清空"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => setBlackboxOpen(false)}
              className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors cursor-pointer"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* 记录列表 */}
        <div className="flex-1 overflow-y-auto px-5 pb-5 flex flex-col gap-2 Qiji-scroll-thin">
          {records.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground text-xs">
              暂无执行记录，运行一个节点后这里会显示请求追踪
            </div>
          ) : (
            records.map((r, i) => <RecordCard key={`${r.nodeId}-${i}`} record={r} />)
          )}
        </div>
      </div>
    </div>
  );
}