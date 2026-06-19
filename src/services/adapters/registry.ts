import type { NodeType } from "@/types";
import type { ModelAdapter } from "./types";

const registry = new Map<string, ModelAdapter>();

export function registerAdapter(adapter: ModelAdapter): void {
  registry.set(adapter.key, adapter);
}

export function getAdapter(key: string): ModelAdapter | undefined {
  return registry.get(key);
}

export function listAdapters(): ModelAdapter[] {
  return [...registry.values()];
}

/** 某节点类型可选的模型列表（底部面板的模型选择器数据源） */
export function listAdaptersForNodeType(type: NodeType): ModelAdapter[] {
  return [...registry.values()].filter((a) => a.nodeTypes.includes(type));
}