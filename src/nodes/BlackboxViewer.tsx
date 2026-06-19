/**
 * BlackboxViewer — 展示单个节点的请求/响应黑匣子记录。
 * 用于在 NodeInfoBar hover 面板中显示详细追踪信息。
 */
import { useState } from "react";
import {
  getBlackbox,
  type RequestEntry,
  type ResponseEntry,
} from "@/services/taskBlackbox";
import { ChevronDown, ChevronRight, Send, ArrowDownLeft, AlertTriangle } from "lucide-react";

function JsonBlock({ data, label }: { data: unknown; label?: string }) {
  const [expanded, setExpanded] = useState(false);
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  const lines = text.split("\n");
  const preview = lines.length > 3 ? lines.slice(0, 3).join("\n") + "\n..." : text;

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
      {(expanded || !label) && (
        <pre
          className="mt-0.5 p-1.5 rounded text-[8px] leading-tight overflow-x-auto whitespace-pre-wrap break-all select-all"
          style={{
            background: "rgba(255,255,255,0.03)",
            border: "1px solid rgba(255,255,255,0.06)",
            color: "var(--foreground)",
            maxHeight: "120px",
          }}
        >
          {expanded ? text : preview}
        </pre>
      )}
    </div>
  );
}

function RequestSection({ req }: { req: RequestEntry }) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-1 text-[9px]">
        <Send className="h-2.5 w-2.5 text-blue-400" />
        <span className="text-blue-400 font-medium">请求</span>
        <span className="text-muted-foreground font-mono text-[8px]">{req.method}</span>
      </div>
      <div className="text-[8px] text-foreground/80 truncate font-mono" title={req.url}>
        {req.url}
      </div>
      <JsonBlock data={req.body} label="Body" />
    </div>
  );
}

function ResponseSection({ res }: { res: ResponseEntry }) {
  const statusColor = res.status >= 400 ? "text-red-400" : res.status >= 200 && res.status < 300 ? "text-emerald-400" : "text-yellow-400";
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-1 text-[9px]">
        <ArrowDownLeft className="h-2.5 w-2.5 text-emerald-400" />
        <span className="text-emerald-400 font-medium">响应</span>
        <span className={`font-mono text-[8px] ${statusColor}`}>{res.status} {res.statusText}</span>
        <span className="text-muted-foreground text-[8px]">{res.durationMs}ms</span>
      </div>
      <JsonBlock data={res.body} label="Body" />
    </div>
  );
}

export function BlackboxViewer({ nodeId }: { nodeId: string }) {
  const record = getBlackbox(nodeId);
  if (!record) return null;

  return (
    <div
      className="mt-2 p-2 rounded-lg flex flex-col gap-2"
      style={{
        background: "rgba(0,0,0,0.3)",
        border: "1px solid rgba(255,255,255,0.06)",
      }}
    >
      {/* 标题行 */}
      <div className="flex items-center justify-between text-[9px]">
        <span className="text-muted-foreground font-mono">
          {record.adapterKey}
        </span>
        <span className="text-muted-foreground text-[8px]">
          {record.startedAt ? new Date(record.startedAt).toLocaleTimeString() : ""}
        </span>
      </div>

      {/* 请求 */}
      {record.request && <RequestSection req={record.request} />}

      {/* 错误 */}
      {record.error && (
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-1 text-[9px]">
            <AlertTriangle className="h-2.5 w-2.5 text-red-400" />
            <span className="text-red-400 font-medium">错误</span>
          </div>
          <div className="text-[8px] text-red-400/80 break-words leading-tight">
            {record.error.message}
          </div>
        </div>
      )}

      {/* 响应 */}
      {record.response && <ResponseSection res={record.response} />}

      {/* 轮询历史 */}
      {record.pollCount && record.pollCount > 0 && (
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
  );
}