import { beforeEach, describe, expect, it, vi } from "vitest";
import { prepareClientUpdate } from "./clientUpdate";
const m = vi.hoisted(() => ({ p: {} as Record<string, any>, canvas: { nodes: {}, runtime: {} } as Record<string, any>,
  windows: [{ label: "main" }], writer: true, prompt: false, ledger: [] as any[], tracked: false, activity: false, invoke: vi.fn() }));
vi.mock("@/store/projectStore", () => ({ useProjectStore: { getState: () => m.p } }));
vi.mock("@/store/canvasStore", () => ({ useCanvasStore: { getState: () => m.canvas } }));
vi.mock("@/store/requestLedgerStore", () => ({ useRequestLedgerStore: { getState: () => ({ entries: m.ledger }) } }));
vi.mock("@/store/promptModalStore", () => ({ usePromptModalStore: { getState: () => ({ open: m.prompt }) } }));
vi.mock("@/store/annotationStore", () => ({ useAnnotationStore: { getState: () => ({ session: null }) } }));
vi.mock("@/store/viewAngleStore", () => ({ useViewAngleStore: { getState: () => ({ session: null }) } }));
vi.mock("@/store/directorStore", () => ({ useDirectorStore: { getState: () => ({ session: null }) } }));
vi.mock("./windowSync", () => ({ isProjectWriter: () => m.writer }));
vi.mock("./taskCenter", () => ({ hasTrackedTasks: () => m.tracked }));
vi.mock("./clientUpdateActivity", () => ({ hasClientActivity: () => m.activity }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ getAllWebviewWindows: async () => m.windows, getCurrentWebviewWindow: () => ({ label: "main" }) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => m.invoke(...a) }));

describe("安装前保存及任务保护", () => {
  beforeEach(() => {
    m.windows = [{ label: "main" }]; m.writer = true; m.prompt = false; m.tracked = false; m.activity = false;
    m.ledger = []; m.canvas = { nodes: {}, runtime: {} }; m.invoke.mockReset().mockResolvedValue(undefined);
    m.p = { savePath: "D:/test/project.Qiji", isDirty: false, isSaving: false, isProjectLoading: false,
      pendingGens: [], inferTasks: [], canvases: {}, rtcDocs: {}, analysisRunning: false,
      markDirty: () => { m.p.isDirty = true; }, save: vi.fn(async () => { m.p.isDirty = false; }) };
  });
  it("即使项目看起来 clean 也保存，成功后才锁定安装", async () => {
    await prepareClientUpdate(); expect(m.p.save).toHaveBeenCalledWith(true);
    expect(m.invoke).toHaveBeenCalledWith("set_client_update_installing", { enabled: true });
  });
  it("save 吞异常仍保留 dirty 时不安装", async () => {
    m.p.save = vi.fn(async () => {}); await expect(prepareClientUpdate()).rejects.toThrow("未能保存");
    expect(m.invoke).not.toHaveBeenCalled();
  });
  it.each(["main-2", "popout-assets"])("其他窗口 %s 存在时不代为关闭、不安装", async label => {
    m.windows.push({ label }); await expect(prepareClientUpdate()).rejects.toThrow("其他 Qiji 窗口"); expect(m.p.save).not.toHaveBeenCalled();
  });
  it("非写者窗口不能用镜像保存成功冒充落盘", async () => {
    m.writer = false; await expect(prepareClientUpdate()).rejects.toThrow("写入窗口"); expect(m.p.save).not.toHaveBeenCalled();
  });
  it("编辑弹窗草稿未提交时暂停", async () => {
    m.prompt = true; await expect(prepareClientUpdate()).rejects.toThrow("编辑弹窗");
  });
  it.each(["analysis", "submit", "upload", "inactive", "ledger", "rtc"])("%s 任务进行中暂停", async kind => {
    if (kind === "analysis") m.p.analysisRunning = true;
    if (kind === "submit") m.activity = true;
    if (kind === "upload") m.canvas.runtime = { n: { status: "uploading" } };
    if (kind === "inactive") m.p.canvases = { inactive: { nodes: { n: { data: { task: {} } } } } };
    if (kind === "ledger") m.ledger = [{ status: "pending" }];
    if (kind === "rtc") m.p.rtcDocs = { episode: { tracks: [{ segments: [{ status: "running" }] }] } };
    await expect(prepareClientUpdate()).rejects.toThrow("任务"); expect(m.invoke).not.toHaveBeenCalled();
  });
  it("保存期间又开启其他窗口时暂停安装", async () => {
    m.p.save = vi.fn(async () => { m.p.isDirty = false; m.windows.push({ label: "main-2" }); });
    await expect(prepareClientUpdate()).rejects.toThrow("其他 Qiji 窗口"); expect(m.invoke).not.toHaveBeenCalled();
  });
});
