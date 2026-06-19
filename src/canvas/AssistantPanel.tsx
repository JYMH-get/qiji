import { useRef, useEffect, useCallback, useState } from "react";
import {
  PanelRightClose,
  Send,
  Trash2,
  Link2,
  Sparkles,
  Loader2,
} from "lucide-react";
import { useAssistantStore } from "@/store/assistantStore";
import { useUiStore } from "@/store/uiStore";
import { useCanvasStore } from "@/store/canvasStore";
import type { ChatMessage } from "@/store/assistantStore";

/* ------------------------------------------------------------------ */
/*  辅助：格式化时间                                                    */
/* ------------------------------------------------------------------ */

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}

/* ------------------------------------------------------------------ */
/*  消息气泡                                                           */
/* ------------------------------------------------------------------ */

function MessageBubble({ msg }: { msg: ChatMessage }) {
  const isUser = msg.role === "user";
  return (
    <div className={`flex flex-col gap-1 ${isUser ? "items-end" : "items-start"}`}>
      {/* 引用节点标签 */}
      {msg.refNodeIds && msg.refNodeIds.length > 0 && (
        <div className="flex flex-wrap gap-1 px-1">
          {msg.refNodeIds.map((nid) => (
            <span
              key={nid}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[9px] font-mono"
              style={{
                background: "color-mix(in srgb, var(--primary) 15%, transparent)",
                color: "var(--primary)",
                border: "1px solid color-mix(in srgb, var(--primary) 25%, transparent)",
              }}
            >
              <Link2 className="h-2.5 w-2.5" />
              {nid.slice(0, 8)}
            </span>
          ))}
        </div>
      )}
      <div
        className={`max-w-[92%] rounded-xl px-3 py-2 text-[12px] leading-relaxed ${
          isUser
            ? "bg-[var(--primary)] text-[var(--primary-foreground)]"
            : "bg-[var(--secondary)] text-[var(--foreground)]"
        }`}
      >
        {msg.content}
      </div>
      <span className="px-1 text-[9px] text-muted-foreground">{fmtTime(msg.timestamp)}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  主面板                                                             */
/* ------------------------------------------------------------------ */

export function AssistantPanel() {
  const open = useAssistantStore((s) => s.open);
  const togglePanel = useAssistantStore((s) => s.togglePanel);
  const messages = useAssistantStore((s) => s.messages);
  const addMessage = useAssistantStore((s) => s.addMessage);
  const streaming = useAssistantStore((s) => s.streaming);
  const setStreaming = useAssistantStore((s) => s.setStreaming);
  const clearMessages = useAssistantStore((s) => s.clearMessages);

  const selectedNodeIds = useUiStore((s) => s.selectedNodeIds);
  const nodes = useCanvasStore((s) => s.nodes);

  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // 自动滚动到底部
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, streaming]);

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || streaming) return;

    // 收集选中节点引用
    const refNodeIds = selectedNodeIds.length > 0 ? [...selectedNodeIds] : undefined;

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: text,
      refNodeIds,
      timestamp: Date.now(),
    };
    addMessage(userMsg);
    setInput("");

    // TODO: 接入真实 AI API（CommandBus / 后端代理）
    // 目前用占位回复模拟流式输出
    setStreaming(true);
    const placeholder: ChatMessage = {
      id: `assistant-${Date.now()}`,
      role: "assistant",
      content: "",
      timestamp: Date.now(),
    };
    addMessage(placeholder);

    const fullReply = buildPlaceholderReply(text, refNodeIds, nodes);
    let idx = 0;
    const timer = setInterval(() => {
      idx += 2;
      if (idx >= fullReply.length) {
        useAssistantStore.getState().appendToLast(fullReply.slice(idx - 2));
        setStreaming(false);
        clearInterval(timer);
      } else {
        useAssistantStore.getState().appendToLast(fullReply.slice(idx - 2, idx));
      }
    }, 18);
  }, [input, streaming, selectedNodeIds, nodes, addMessage, setStreaming]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  return (
    <>
      {/* 折叠态：右侧小按钮 */}
      {!open && (
        <button
          onClick={togglePanel}
          title="画布助手"
          className="pointer-events-auto absolute right-4 top-1/2 z-[10200] flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-xl transition-colors hover:bg-secondary"
          style={{
            background: "rgba(18, 20, 26, 0.82)",
            backdropFilter: "blur(14px)",
            boxShadow: "0 4px 16px rgba(0,0,0,0.35)",
            border: "1px solid rgba(255,255,255,0.07)",
          }}
        >
          <Sparkles className="h-4 w-4 text-[var(--primary)]" />
        </button>
      )}

      {/* 展开态：聊天面板 */}
      {open && (
        <div
          className="pointer-events-auto absolute right-4 top-2 bottom-14 z-[10200] flex flex-col rounded-2xl overflow-hidden"
          style={{
            width: 340,
            background: "rgba(18, 20, 26, 0.92)",
            border: "1px solid rgba(255,255,255,0.07)",
            backdropFilter: "blur(16px)",
            boxShadow: "0 8px 40px rgba(0,0,0,0.5)",
          }}
        >
          {/* 头部 */}
          <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-2.5">
            <div className="flex items-center gap-2 text-[12px] font-medium text-foreground">
              <Sparkles className="h-3.5 w-3.5 text-[var(--primary)]" />
              画布助手
            </div>
            <div className="flex items-center gap-1">
              {messages.length > 0 && (
                <button
                  onClick={clearMessages}
                  title="清空对话"
                  className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              )}
              <button
                onClick={togglePanel}
                title="收起面板"
                className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              >
                <PanelRightClose className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          {/* 选中节点提示 */}
          {selectedNodeIds.length > 0 && (
            <div className="flex items-center gap-1.5 border-b border-white/[0.04] px-4 py-1.5 text-[10px] text-muted-foreground">
              <Link2 className="h-2.5 w-2.5" />
              已选中 {selectedNodeIds.length} 个节点，发送时将自动引用
            </div>
          )}

          {/* 消息区 */}
          <div
            ref={scrollRef}
            className="flex-1 overflow-y-auto px-3 py-3 flex flex-col gap-3 Qiji-scroll-thin"
          >
            {messages.length === 0 && (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center text-muted-foreground">
                <Sparkles className="h-8 w-8 opacity-20" />
                <p className="text-[12px] leading-relaxed max-w-[220px]">
                  与 AI 对话，引用画布节点
                  <br />
                  生成内容可一键插入
                </p>
              </div>
            )}
            {messages.map((msg) => (
              <MessageBubble key={msg.id} msg={msg} />
            ))}
            {streaming && (
              <div className="flex items-center gap-1.5 px-2 text-[10px] text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                正在思考…
              </div>
            )}
          </div>

          {/* 输入区 */}
          <div className="border-t border-white/[0.06] p-3">
            <div className="flex items-end gap-2 rounded-xl bg-[var(--secondary)] px-3 py-2">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="输入消息…（Enter 发送）"
                rows={1}
                className="flex-1 resize-none bg-transparent text-[12px] text-foreground placeholder:text-muted-foreground outline-none Qiji-scroll-thin"
                style={{ maxHeight: 80 }}
              />
              <button
                onClick={handleSend}
                disabled={!input.trim() || streaming}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors disabled:opacity-30"
                style={{
                  background: input.trim() ? "var(--primary)" : "transparent",
                  color: input.trim() ? "var(--primary-foreground)" : "var(--muted-foreground)",
                }}
              >
                <Send className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  占位回复（待接入真实 API 后移除）                                     */
/* ------------------------------------------------------------------ */

function buildPlaceholderReply(
  input: string,
  refNodeIds?: string[],
  nodes?: Record<string, any>,
): string {
  const refs = refNodeIds
    ?.map((id) => {
      const n = nodes?.[id];
      return n ? `[${n.type ?? "unknown"}: ${id.slice(0, 8)}]` : `[${id.slice(0, 8)}]`;
    })
    .join(" ");

  if (refs) {
    return `已收到你引用的节点：${refs}\n\n你的问题：「${input}」\n\n这是一个占位回复。后续将接入 CommandBus → 后端代理 → AI 模型，实现真实的对话生成能力。届时可将生成结果一键插入画布作为新节点。`;
  }
  return `收到你的消息：「${input}」\n\n这是一个占位回复。后续将接入 CommandBus → 后端代理 → AI 模型，实现真实的对话生成能力。`;
}