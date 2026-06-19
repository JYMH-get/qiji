import { describe, it, expect, beforeEach, vi } from "vitest";
import { CommandBus, type CommandHandler } from "./commandBus";
import { STRUCTURAL_COMMANDS, AGENT_AUTO_ALLOWED } from "./commands";
import type { Command } from "./commands";

/**
 * CommandBus 单元测试：验证命令注册、分发、自动模式守卫、结构命令判定。
 * 使用独立的 CommandBus 实例，不依赖 canvasStore。
 */

// Mock canvasStore so pushHistory doesn't require full Zustand setup
vi.mock("@/store/canvasStore", () => ({
  useCanvasStore: {
    getState: () => ({ pushHistory: vi.fn() }),
  },
}));

describe("CommandBus", () => {
  let bus: CommandBus;

  beforeEach(() => {
    bus = new CommandBus();
  });

  it("注册处理器后能分发命令", () => {
    const calls: Command[] = [];
    const handler: CommandHandler = (cmd) => calls.push(cmd);

    bus.register("addNode", handler);
    bus.dispatch(
      { type: "addNode", node: { id: "n1", type: "image", x: 0, y: 0, w: 100, h: 100, parentId: null, parentScriptId: null, data: { input: {}, params: {}, resultAssetId: null } } },
      { source: "gui" },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].type).toBe("addNode");
  });

  it("同命令可注册多个处理器", () => {
    let count = 0;
    bus.register("deleteNode", () => count++);
    bus.register("deleteNode", () => count++);

    bus.dispatch({ type: "deleteNode", id: "x" }, { source: "gui" });
    expect(count).toBe(2);
  });

  it("register 返回取消注册函数", () => {
    let called = false;
    const unregister = bus.register("connect", () => { called = true; });
    unregister();

    bus.dispatch(
      { type: "connect", edge: { id: "e1", kind: "dataflow", source: "a", sourcePort: "p", target: "b", targetPort: "q" } },
      { source: "gui" },
    );
    expect(called).toBe(false);
  });

  it("未注册的命令只警告，不抛异常", () => {
    expect(() => {
      bus.dispatch({ type: "run", nodeId: "x" }, { source: "gui" });
    }).not.toThrow();
  });

  it("isStructural 正确判定结构命令", () => {
    expect(bus.isStructural("addNode")).toBe(true);
    expect(bus.isStructural("deleteNode")).toBe(true);
    expect(bus.isStructural("connect")).toBe(true);
    expect(bus.isStructural("disconnect")).toBe(true);
    expect(bus.isStructural("group")).toBe(true);
    expect(bus.isStructural("pasteNodes")).toBe(true);
    expect(bus.isStructural("setNodeResultAsset")).toBe(true);
  });

  it("isStructural 判定非结构命令为 false", () => {
    expect(bus.isStructural("run")).toBe(false);
    expect(bus.isStructural("schedule")).toBe(false);
    expect(bus.isStructural("cancelSchedule")).toBe(false);
    expect(bus.isStructural("undo")).toBe(false);
    expect(bus.isStructural("redo")).toBe(false);
    expect(bus.isStructural("executeNodeAction")).toBe(false);
  });
});

describe("STRUCTURAL_COMMANDS 集合", () => {
  it("包含所有应进入撤销栈的命令", () => {
    const expected = [
      "addNode", "updateNodePosition", "resizeNode", "deleteNode",
      "connect", "disconnect", "pasteNodes", "insertOnEdge",
      "group", "ungroup", "burstScript", "setNodeResultAsset",
    ];
    for (const cmd of expected) {
      expect(STRUCTURAL_COMMANDS.has(cmd as any)).toBe(true);
    }
  });

  it("不包含运行时命令", () => {
    expect(STRUCTURAL_COMMANDS.has("run" as any)).toBe(false);
    expect(STRUCTURAL_COMMANDS.has("schedule" as any)).toBe(false);
    expect(STRUCTURAL_COMMANDS.has("cancelSchedule" as any)).toBe(false);
  });
});

describe("AGENT_AUTO_ALLOWED 白名单", () => {
  it("仅包含 run/schedule/cancelSchedule", () => {
    expect(AGENT_AUTO_ALLOWED.size).toBe(3);
    expect(AGENT_AUTO_ALLOWED.has("run")).toBe(true);
    expect(AGENT_AUTO_ALLOWED.has("schedule")).toBe(true);
    expect(AGENT_AUTO_ALLOWED.has("cancelSchedule")).toBe(true);
  });

  it("不包含任何结构命令", () => {
    for (const cmd of AGENT_AUTO_ALLOWED) {
      expect(STRUCTURAL_COMMANDS.has(cmd)).toBe(false);
    }
  });
});