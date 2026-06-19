import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  initDebouncedSave,
  scheduleSave,
  cancelAllSaves,
} from "./debouncedSave";

/**
 * debouncedSave 单元测试：验证三档去抖策略、拖拽暂停、取消。
 */

describe("debouncedSave", () => {
  let mockSave: ReturnType<typeof vi.fn>;
  let mockMarkDirty: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockSave = vi.fn().mockResolvedValue(undefined);
    mockMarkDirty = vi.fn();
    initDebouncedSave(mockSave as any, mockMarkDirty as any);
  });

  afterEach(() => {
    cancelAllSaves();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("scheduleSave 调用 markDirty", () => {
    scheduleSave("canvas");
    expect(mockMarkDirty).toHaveBeenCalledTimes(1);
  });

  it("canvas 档 400ms 后触发保存", async () => {
    scheduleSave("canvas");
    expect(mockSave).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(400);
    expect(mockSave).toHaveBeenCalledTimes(1);
  });

  it("history 档 180ms 后触发保存", async () => {
    scheduleSave("history");
    await vi.advanceTimersByTimeAsync(180);
    expect(mockSave).toHaveBeenCalledTimes(1);
  });

  it("viewport 档 500ms 后触发保存", async () => {
    scheduleSave("viewport");
    await vi.advanceTimersByTimeAsync(400);
    expect(mockSave).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);
    expect(mockSave).toHaveBeenCalledTimes(1);
  });

  it("同一档位多次调度只执行最后一次（去抖）", async () => {
    scheduleSave("canvas");
    scheduleSave("canvas");
    scheduleSave("canvas");

    await vi.advanceTimersByTimeAsync(400);
    expect(mockSave).toHaveBeenCalledTimes(1);
  });

  it("不同档位独立去抖", async () => {
    scheduleSave("canvas");
    scheduleSave("viewport");

    await vi.advanceTimersByTimeAsync(400);
    expect(mockSave).toHaveBeenCalledTimes(1); // canvas

    await vi.advanceTimersByTimeAsync(100);
    expect(mockSave).toHaveBeenCalledTimes(2); // + viewport
  });

  it("cancelAllSaves 取消所有待执行的保存", async () => {
    scheduleSave("canvas");
    scheduleSave("history");
    scheduleSave("viewport");
    cancelAllSaves();

    await vi.advanceTimersByTimeAsync(1000);
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("默认档位为 canvas", async () => {
    scheduleSave();
    await vi.advanceTimersByTimeAsync(399);
    expect(mockSave).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(mockSave).toHaveBeenCalledTimes(1);
  });

  it("markDirty 每次 schedule 都调用（不受去抖影响）", () => {
    scheduleSave("canvas");
    scheduleSave("canvas");
    scheduleSave("canvas");
    expect(mockMarkDirty).toHaveBeenCalledTimes(3);
  });
});