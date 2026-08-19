import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  initDebouncedSave,
  scheduleSave,
  notifySaved,
  cancelAllSaves,
} from "./debouncedSave";

/**
 * debouncedSave 单元测试：验证 2 分钟合并窗口、脏标记跳过、拖拽暂停、取消。
 */

const AUTOSAVE_MS = 2 * 60 * 1000;

describe("debouncedSave（2 分钟自动保存窗口）", () => {
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

  it("2 分钟后才触发保存", async () => {
    scheduleSave("canvas");
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS - 1);
    expect(mockSave).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(mockSave).toHaveBeenCalledTimes(1);
  });

  it("窗口内多次改动合并成一次保存", async () => {
    scheduleSave("canvas");
    await vi.advanceTimersByTimeAsync(60_000);
    scheduleSave("history");
    scheduleSave("viewport");
    scheduleSave("canvas");
    // 窗口从第一次改动起算，第一次调度后 2 分钟触发一次
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS - 60_000);
    expect(mockSave).toHaveBeenCalledTimes(1);
  });

  it("连续编辑最多每 2 分钟保存一次", async () => {
    scheduleSave("canvas");
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(mockSave).toHaveBeenCalledTimes(1); // 第一窗口

    scheduleSave("canvas"); // 保存后再次编辑，开启新窗口
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(mockSave).toHaveBeenCalledTimes(2); // 第二窗口
  });

  it("notifySaved 清脏标记：窗口到点若无新改动则跳过", async () => {
    scheduleSave("canvas");
    // 期间有一次 save(true) 立即落盘
    notifySaved();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("notifySaved 后再有改动仍会自动保存", async () => {
    scheduleSave("canvas");
    notifySaved();
    scheduleSave("canvas"); // 新改动
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(mockSave).toHaveBeenCalledTimes(1);
  });

  it("cancelAllSaves 取消待执行的保存", async () => {
    scheduleSave("canvas");
    cancelAllSaves();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS * 2);
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("markDirty 每次 schedule 都调用", () => {
    scheduleSave("canvas");
    scheduleSave("canvas");
    scheduleSave("canvas");
    expect(mockMarkDirty).toHaveBeenCalledTimes(3);
  });
});
