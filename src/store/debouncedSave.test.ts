import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  initDebouncedSave,
  scheduleSave,
  notifySaved,
  cancelAllSaves,
  flushScheduledSave,
  getSaveRevision,
} from "./debouncedSave";

/**
 * debouncedSave 单元测试：验证 30 秒合并窗口、脏标记跳过、拖拽暂停、取消。
 */

const AUTOSAVE_MS = 30 * 1000;

describe("debouncedSave（30 秒自动保存窗口）", () => {
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

  it("30 秒后才触发保存", async () => {
    scheduleSave("canvas");
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS - 1);
    expect(mockSave).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(mockSave).toHaveBeenCalledTimes(1);
  });

  it("窗口内多次改动合并成一次保存", async () => {
    scheduleSave("canvas");
    await vi.advanceTimersByTimeAsync(10_000);
    scheduleSave("history");
    scheduleSave("viewport");
    scheduleSave("canvas");
    // 窗口从第一次改动起算，第一次调度后 30 秒触发一次
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS - 10_000);
    expect(mockSave).toHaveBeenCalledTimes(1);
  });

  it("连续编辑最多每 30 秒保存一次", async () => {
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

  it("切换提前保存一次，并取消旧窗口", async () => {
    scheduleSave();
    await vi.advanceTimersByTimeAsync(5_000);
    await flushScheduledSave();
    expect(mockSave).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(mockSave).toHaveBeenCalledTimes(1);
  });

  it("旧保存完成不能清除保存期间的新改动", async () => {
    scheduleSave();
    const savedRevision = getSaveRevision();
    scheduleSave();
    expect(notifySaved(savedRevision)).toBe(false);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(mockSave).toHaveBeenCalledTimes(1);
  });

  it("即时保存后新编辑重新计算完整30秒窗口", async () => {
    scheduleSave();
    await vi.advanceTimersByTimeAsync(29_000);
    notifySaved();
    scheduleSave();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mockSave).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(29_000);
    expect(mockSave).toHaveBeenCalledTimes(1);
  });
});
