import { useRef } from "react";
import type { CanvasEdge, CanvasNode } from "@/types";

/**
 * 模块级剪贴板：跨组件共享复制数据。
 */
interface ClipboardData {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

let clipboardRef: ClipboardData | null = null;

export function copyToClipboard(nodes: CanvasNode[], edges: CanvasEdge[]): void {
  clipboardRef = { nodes, edges };
}

export function pasteFromClipboard(): ClipboardData | null {
  return clipboardRef ? structuredClone(clipboardRef) : null;
}

export function hasClipboardData(): boolean {
  return clipboardRef !== null && clipboardRef.nodes.length > 0;
}

/**
 * React hook：对外暴露剪贴板操作（方便组件内使用）。
 */
export function useClipboardStore() {
  const ref = useRef({ copyToClipboard, pasteFromClipboard, hasClipboardData });
  return ref.current;
}