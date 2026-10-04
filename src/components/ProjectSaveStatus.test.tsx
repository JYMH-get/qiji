import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  writer: true,
  project: { cloudBackupId: "backup-a", isDirty: false, isSaving: false, savePath: "D:/fixture/project.Qiji" as string | null },
  settings: { enableCloudSync: false, webdavUrl: "" },
  backups: { statuses: {} as Record<string, { phase: string; error?: string; lastSuccessAt?: number }> },
}));
vi.mock("@/services/windowSync", () => ({ isProjectWriter: () => state.writer }));
vi.mock("@/store/projectStore", () => ({ useProjectStore: (selector: any) => selector(state.project) }));
vi.mock("@/store/settingsStore", () => ({ useSettingsStore: (selector: any) => selector(state.settings) }));
vi.mock("@/services/projectCloudBackup", () => ({
  useProjectBackupStore: (selector: any) => selector(state.backups), retryProjectBackup: vi.fn(),
}));
import { ProjectSaveStatus } from "./ProjectSaveStatus";
describe("项目保存与云备份状态", () => {
  beforeEach(() => {
    state.writer = true;
    state.project = { cloudBackupId: "backup-a", isDirty: false, isSaving: false, savePath: "D:/fixture/project.Qiji" };
    state.settings = { enableCloudSync: false, webdavUrl: "" };
    state.backups.statuses = {};
  });
  const render = () => renderToStaticMarkup(<ProjectSaveStatus />);
  it("未配置云端时只报告本地保存，不显示云成功", () => {
    expect(render()).toContain("本地已保存");
    expect(render()).not.toContain("项目文件已备份");
  });
  it("开启但地址为空报告待配置", () => {
    state.settings.enableCloudSync = true;
    expect(render()).toContain("云备份待配置");
  });
  it("失败显示原因和重试，保留本地保存结果", () => {
    state.settings = { enableCloudSync: true, webdavUrl: "https://backup.invalid" };
    state.backups.statuses["backup-a"] = { phase: "error", error: "认证失败" };
    const html = render();
    expect(html).toContain("本地已保存"); expect(html).toContain("云备份失败");
    expect(html).toContain("认证失败"); expect(html).toContain("重试");
  });
  it("旧备份成功后仍有编辑，提示待保存而非已备份", () => {
    state.settings = { enableCloudSync: true, webdavUrl: "https://backup.invalid" };
    state.backups.statuses["backup-a"] = { phase: "success", lastSuccessAt: 1000 };
    state.project.isDirty = true;
    expect(render()).toContain("云备份待保存");
    expect(render()).not.toContain("项目文件已备份");
  });
  it("切换同名项目不继承另一个项目的云成功", () => {
    state.settings = { enableCloudSync: true, webdavUrl: "https://backup.invalid" };
    state.backups.statuses["backup-a"] = { phase: "success" };
    state.project.cloudBackupId = "backup-b";
    expect(render()).not.toContain("项目文件已备份");
  });
  it("从窗口明确由主窗口保存，不冒报成功或等待上传", () => {
    state.writer = false;
    state.settings = { enableCloudSync: true, webdavUrl: "https://backup.invalid" };
    expect(render()).toContain("由主窗口保存");
    expect(render()).not.toContain("本地已保存");
    expect(render()).not.toContain("云备份待保存");
  });
});
