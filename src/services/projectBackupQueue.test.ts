import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectBackupQueue } from "./projectBackupQueue";

const config = { url: "https://backup.invalid", directory: "/projects", username: "fixture", password: "fixture" };
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
describe("项目文件云备份排队", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
  function setup() {
    const upload = vi.fn().mockResolvedValue(undefined);
    const publish = vi.fn();
    const queue = createProjectBackupQueue(upload, publish);
    queue.configure(config);
    return { upload, publish, queue };
  }
  it("同名项目有不同远端身份，两秒内保存都上传", async () => {
    const { upload, queue } = setup();
    const json = JSON.stringify({ name: "同名项目" });
    queue.enqueue("backup-a", json); queue.enqueue("backup-b", json);
    await vi.advanceTimersByTimeAsync(2000);
    expect(upload.mock.calls.map(c => c[1])).toEqual(["backup-a.Qiji", "backup-b.Qiji"]);
    expect(upload.mock.calls.every(c => c[2] === json)).toBe(true);
  });
  it("同项目短时间多次保存只上传最新完整快照", async () => {
    const { upload, queue } = setup();
    queue.enqueue("backup-a", "old");
    await vi.advanceTimersByTimeAsync(1000);
    queue.enqueue("backup-a", "new");
    await vi.advanceTimersByTimeAsync(2000);
    expect(upload).toHaveBeenCalledExactlyOnceWith(config, "backup-a.Qiji", "new");
  });
  it("较慢旧上传结束后才上传新快照，旧内容不会最后覆盖新内容", async () => {
    const { upload, publish, queue } = setup();
    const old = deferred(); upload.mockReturnValueOnce(old.promise);
    queue.enqueue("backup-a", "old"); await vi.advanceTimersByTimeAsync(2000);
    queue.enqueue("backup-a", "new"); await vi.advanceTimersByTimeAsync(2000);
    expect(upload).toHaveBeenCalledTimes(1);
    old.resolve(); await vi.advanceTimersByTimeAsync(0);
    expect(upload.mock.calls.map(c => c[2])).toEqual(["old", "new"]);
    expect(publish.mock.lastCall?.[1].phase).toBe("success");
  });
  it("失败可见，手动重试保留原项目快照", async () => {
    const { upload, publish, queue } = setup();
    upload.mockRejectedValueOnce(new Error("认证失败"));
    queue.enqueue("backup-a", "saved-json"); await vi.advanceTimersByTimeAsync(2000);
    expect(publish.mock.lastCall).toEqual(["backup-a", { phase: "error", error: "认证失败", lastSuccessAt: undefined }]);
    queue.retry("backup-a"); await vi.advanceTimersByTimeAsync(0);
    expect(upload).toHaveBeenLastCalledWith(config, "backup-a.Qiji", "saved-json");
    expect(publish.mock.lastCall?.[1].phase).toBe("success");
  });
  it("已有新保存排队时旧上传失败不覆盖新状态，仍继续新快照", async () => {
    const { upload, publish, queue } = setup();
    const old = deferred(); upload.mockReturnValueOnce(old.promise);
    queue.enqueue("backup-a", "old"); await vi.advanceTimersByTimeAsync(2000);
    queue.enqueue("backup-a", "new"); old.reject(new Error("old failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(publish.mock.lastCall?.[1].phase).toBe("waiting");
    await vi.advanceTimersByTimeAsync(2000);
    expect(upload).toHaveBeenLastCalledWith(config, "backup-a.Qiji", "new");
  });
  it("关闭配置取消尚未开始的上传及重试", async () => {
    const { upload, queue } = setup();
    queue.enqueue("backup-a", "old"); queue.configure(null); queue.retry("backup-a");
    await vi.advanceTimersByTimeAsync(2000);
    expect(upload).not.toHaveBeenCalled();
  });
  it("配置变化隔离旧结果，并在旧请求结束后上传新配置快照", async () => {
    const { upload, publish, queue } = setup();
    const old = deferred(); upload.mockReturnValueOnce(old.promise);
    queue.enqueue("backup-a", "old"); await vi.advanceTimersByTimeAsync(2000);
    const next = { ...config, directory: "/new" };
    queue.configure(next); queue.enqueue("backup-a", "new");
    await vi.advanceTimersByTimeAsync(2000); publish.mockClear();
    old.resolve(); await vi.advanceTimersByTimeAsync(0);
    expect(upload).toHaveBeenLastCalledWith(next, "backup-a.Qiji", "new");
    expect(publish.mock.calls.map(c => c[1].phase)).toEqual(["uploading", "success"]);
  });
  it("成功后不保留可重试的旧快照", async () => {
    const { upload, queue } = setup();
    queue.enqueue("backup-a", "json"); await vi.advanceTimersByTimeAsync(2000);
    queue.retry("backup-a"); await vi.advanceTimersByTimeAsync(0);
    expect(upload).toHaveBeenCalledTimes(1);
  });
  it("拒绝将项目名或路径当远端对象身份", () => {
    const { queue } = setup();
    expect(() => queue.enqueue("../同名项目", "json")).toThrow("无效项目备份标识");
  });
});
