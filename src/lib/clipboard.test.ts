import { describe, it, expect, beforeEach } from "vitest";
import {
  copyToClipboard,
  pasteFromClipboard,
  hasClipboardData,
} from "./clipboard";
import type { CanvasNode, CanvasEdge } from "@/types";

function makeNode(overrides?: Partial<CanvasNode>): CanvasNode {
  return {
    id: "node-1",
    type: "image",
    x: 0,
    y: 0,
    w: 240,
    h: 200,
    parentId: null,
    parentScriptId: null,
    data: { input: {}, params: { prompt: "test" }, resultAssetId: null },
    ...overrides,
  };
}

function makeEdge(overrides?: Partial<CanvasEdge>): CanvasEdge {
  return {
    id: "edge-1",
    kind: "dataflow",
    source: "node-1",
    sourcePort: "shot",
    target: "node-2",
    targetPort: "text",
    ...overrides,
  };
}

describe("clipboard", () => {
  beforeEach(() => {
    // 重置模块级剪贴板：通过复制空数据实现
    copyToClipboard([], []);
  });

  it("初始状态无剪贴板数据", () => {
    expect(hasClipboardData()).toBe(false);
  });

  it("复制后 hasClipboardData 返回 true", () => {
    copyToClipboard([makeNode()], []);
    expect(hasClipboardData()).toBe(true);
  });

  it("复制空节点数组不算有数据", () => {
    copyToClipboard([], []);
    expect(hasClipboardData()).toBe(false);
  });

  it("粘贴返回深拷贝（不是引用）", () => {
    const node = makeNode({ id: "node-A" });
    copyToClipboard([node], []);

    const pasted = pasteFromClipboard()!;
    expect(pasted.nodes).toHaveLength(1);
    expect(pasted.nodes[0].id).toBe("node-A");

    // 修改粘贴结果不影响剪贴板
    pasted.nodes[0].id = "mutated";
    const pasted2 = pasteFromClipboard()!;
    expect(pasted2.nodes[0].id).toBe("node-A");
  });

  it("复制多个节点和多条边", () => {
    const nodes = [
      makeNode({ id: "n1" }),
      makeNode({ id: "n2" }),
      makeNode({ id: "n3" }),
    ];
    const edges = [
      makeEdge({ id: "e1" }),
      makeEdge({ id: "e2" }),
    ];
    copyToClipboard(nodes, edges);

    const pasted = pasteFromClipboard()!;
    expect(pasted.nodes).toHaveLength(3);
    expect(pasted.edges).toHaveLength(2);
    expect(pasted.edges[0].source).toBe("node-1");
  });

  it("无数据时粘贴返回 null", () => {
    // beforeEach 已重置为空
    copyToClipboard([], []);
    expect(pasteFromClipboard()!.nodes).toHaveLength(0);
  });

  it("多次复制覆盖前一次", () => {
    copyToClipboard([makeNode({ id: "first" })], []);
    copyToClipboard([makeNode({ id: "second" })], []);

    const pasted = pasteFromClipboard()!;
    expect(pasted.nodes).toHaveLength(1);
    expect(pasted.nodes[0].id).toBe("second");
  });

  it("深拷贝包含嵌套参数", () => {
    const node = makeNode({
      id: "nested",
      data: {
        input: { text: "上游内容" },
        params: { prompt: "hello", style: "anime", nested: { key: "val" } },
        resultAssetId: "asset-123",
      },
    });
    copyToClipboard([node], []);

    const pasted = pasteFromClipboard()!;
    expect(pasted.nodes[0].data.params.style).toBe("anime");
    expect(pasted.nodes[0].data.params.nested).toEqual({ key: "val" });
    expect(pasted.nodes[0].data.resultAssetId).toBe("asset-123");

    // 修改嵌套值不影响原剪贴板
    (pasted.nodes[0].data.params as any).nested.key = "changed";
    const pasted2 = pasteFromClipboard()!;
    expect(pasted2.nodes[0].data.params.nested).toEqual({ key: "val" });
  });
});