import { describe, expect, it, vi } from "vitest";
import { ClientUpdateController, type PendingUpdate } from "./clientUpdateCore";

function setup() {
  const update: PendingUpdate = { version: "2.0.2", body: "更新说明", download: vi.fn(async cb => {
    cb({ event: "Started", data: { contentLength: 100 } });
    cb({ event: "Progress", data: { chunkLength: 40 } });
    cb({ event: "Progress", data: { chunkLength: 60 } });
  }), install: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  const ports = { check: vi.fn(async (): Promise<PendingUpdate | null> => update), prepare: vi.fn(async () => {}), relaunch: vi.fn(async () => {}) };
  return { update, ports, c: new ClientUpdateController(ports, vi.fn()) };
}
describe("客户端自动更新", () => {
  it("后台自动下载到 ready，绝不自动安装", async () => {
    const { c, update, ports } = setup(); await c.check();
    expect(c.state).toMatchObject({ phase: "ready", version: "2.0.2", downloaded: 100, total: 100, visible: true });
    expect(update.install).not.toHaveBeenCalled(); expect(ports.prepare).not.toHaveBeenCalled();
  });
  it("用户选择稍后保留下载结果，手动打开不重复下载", async () => {
    const { c, update } = setup(); await c.check(); c.dismiss(); expect(c.state.visible).toBe(false);
    await c.check(true); expect(c.state.visible).toBe(true); expect(update.download).toHaveBeenCalledTimes(1);
  });
  it("连续检查和重复安装点击去重", async () => {
    const { c, ports, update } = setup(); await Promise.all([c.check(), c.check(true)]);
    expect(ports.check).toHaveBeenCalledTimes(1);
    await Promise.all([c.install(), c.install()]); expect(update.install).toHaveBeenCalledTimes(1);
    expect(ports.prepare.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(update.install).mock.invocationCallOrder[0]);
  });
  it("项目保存失败、忙碌或其他窗口阻挡时不安装，仍可重试", async () => {
    const { c, update, ports } = setup(); await c.check();
    ports.prepare.mockRejectedValueOnce(new Error("项目未能保存")); await c.install();
    expect(c.state).toMatchObject({ phase: "ready", message: "项目未能保存" });
    expect(update.install).not.toHaveBeenCalled(); expect(ports.relaunch).not.toHaveBeenCalled();
    await c.install(); expect(update.install).toHaveBeenCalledTimes(1);
  });
  it("签名/下载失败释放候选，不显示 ready，不允许安装", async () => {
    const { c, update } = setup(); vi.mocked(update.download).mockRejectedValueOnce(new Error("signature invalid"));
    await c.check(); await c.install(); expect(c.state.phase).toBe("error");
    expect(update.close).toHaveBeenCalledTimes(1); expect(update.install).not.toHaveBeenCalled();
    await c.check(true); expect(c.state.phase).toBe("ready");
  });
  it("无新版时自动检查静默、手动检查明确提示", async () => {
    const { c, ports } = setup(); ports.check.mockResolvedValue(null); await c.check();
    expect(c.state).toMatchObject({ phase: "idle", visible: false }); await c.check(true);
    expect(c.state).toMatchObject({ message: "当前已是最新版本", visible: true });
  });
  it("安装失败释放下载资源并提示重试，不重启", async () => {
    const { c, ports, update } = setup(); await c.check();
    vi.mocked(update.install).mockRejectedValue(new Error("disk full")); await c.install();
    expect(c.state.phase).toBe("error"); expect(update.close).toHaveBeenCalled(); expect(ports.relaunch).not.toHaveBeenCalled();
  });
});
