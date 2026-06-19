import { useRef, useEffect, useMemo, useCallback } from "react";

import { extractMentions, getMentionSuggestions } from "@/lib/mentionResolver";
import { useCanvasStore } from "@/store/canvasStore";

/**
 * PromptComposer — textarea + 高亮覆盖层
 *
 * 原理：透明 textarea 叠在一个 backdrop div 上方，
 * backdrop 渲染同样文本但 @[port] 高亮为彩色 span。
 * 两者字体、行高、padding 完全一致，滚动同步。
 */
export function PromptComposer({
  nodeId,
  prompt,
  onChange,
  onKeyDown,
  placeholder,
  minHeight = 100,
  maxHeight = 290,
}: {
  nodeId: string;
  prompt: string;
  onChange: (value: string) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  placeholder?: string;
  minHeight?: number;
  maxHeight?: number;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);

  // 自动高度
  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      const next = Math.min(Math.max(el.scrollHeight, minHeight), maxHeight);
      el.style.height = `${next}px`;
    }
    // 同步 backdrop 高度
    if (backdropRef.current) {
      backdropRef.current.style.height = el ? `${el.offsetHeight}px` : "auto";
    }
  }, [prompt, minHeight, maxHeight]);

  // 提取 mention 并判断连接状态
  const edgesMap = useCanvasStore((s) => s.edges);
  const mentionInfo = useMemo(() => {
    const tokens = extractMentions(prompt);
    const suggestions = getMentionSuggestions(nodeId);
    return tokens.map((portName) => {
      const s = suggestions.find((x) => x.portName === portName);
      return { portName, connected: s?.upstreamNodeId !== null && s?.upstreamNodeId !== undefined };
    });
  }, [prompt, nodeId, edgesMap]);

  // 渲染 backdrop HTML（将 @[port] 替换为高亮 span）
  const backdropHtml = useMemo(() => {
    let html = escapeHtml(prompt);
    for (const { portName, connected } of mentionInfo) {
      const token = `@[${portName}]`;
      const escaped = escapeHtml(token);
      const colorClass = connected
        ? "Qiji-mention--ok"
        : "Qiji-mention--disconnected";
      const replacement = `<span class="Qiji-mention ${colorClass}">${escaped}</span>`;
      // 替换所有出现
      html = html.split(escaped).join(replacement);
    }
    // 末尾加空格确保光标在行尾时 backdrop 对齐
    return html + " ";
  }, [prompt, mentionInfo]);

  // 同步滚动
  const handleScroll = useCallback(() => {
    if (textareaRef.current && backdropRef.current) {
      backdropRef.current.scrollTop = textareaRef.current.scrollTop;
      backdropRef.current.scrollLeft = textareaRef.current.scrollLeft;
    }
  }, []);

  return (
    <div className="Qiji-composer relative">
      {/* Backdrop 高亮层 */}
      <div
        ref={backdropRef}
        className="Qiji-composer-backdrop nodrag"
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: backdropHtml }}
      />
      {/* 透明输入层 */}
      <textarea
        ref={textareaRef}
        className="Qiji-composer-input nodrag"
        value={prompt}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onScroll={handleScroll}
        placeholder={placeholder ?? "输入提示词（输入 @ 引用上游素材）…"}
        spellCheck={false}
      />
    </div>
  );
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}