import { describe, it, expect } from "vitest";
import {
  migrateProject,
  addMigrationLog,
  Qiji_VERSION,
  type QijiProject,
  type CommitSnapshot,
} from "./projectFile";

/** 构造一个最小的 v2.0 项目对象 */
function makeV2Project(overrides?: Partial<QijiProject>): QijiProject {
  return {
    version: "2.0",
    name: "测试项目",
    savedAt: "2026-01-01T00:00:00.000Z",
    head: "commit-init",
    commits: {
      "commit-init": {
        commitId: "commit-init",
        parentIds: [],
        message: "初始化",
        author: "System",
        timestamp: "2026-01-01T00:00:00.000Z",
        canvas: { nodes: {}, edges: {}, groups: {} },
        assets: {},
      },
    },
    files: {},
    ...overrides,
  };
}

/** 构造一个 v1.x 项目对象（无 commits） */
function makeV1Project(): Record<string, unknown> {
  return {
    version: "1.0",
    name: "旧项目",
    savedAt: "2025-06-01T00:00:00.000Z",
    nodes: { "node-1": { id: "node-1", type: "image", x: 10, y: 20, w: 240, h: 200 } },
    edges: {},
    groups: {},
    viewport: { x: 5, y: 10, zoom: 0.8 },
    assets: { "asset-1": { id: "asset-1", kind: "image", name: "test.png" } },
    files: { "file-1": "/path/to/file" },
  };
}

describe("migrateProject", () => {
  it("v2.0 项目直接返回，不修改", () => {
    const v2 = makeV2Project();
    const result = migrateProject(v2);
    expect(result.version).toBe("2.0");
    expect(result.head).toBe("commit-init");
    expect(Object.keys(result.commits)).toHaveLength(1);
  });

  it("v1.x 项目迁移到 v2.0，生成初始提交", () => {
    const v1 = makeV1Project();
    const result = migrateProject(v1);
    expect(result.version).toBe("2.0");
    expect(result.head).toBe("commit-init");
    expect(result.commits["commit-init"]).toBeDefined();
  });

  it("迁移后保留原始画布数据", () => {
    const v1 = makeV1Project();
    const result = migrateProject(v1);
    const initCommit = result.commits["commit-init"];
    expect(initCommit.canvas.nodes).toEqual(v1.nodes);
    expect(initCommit.canvas.edges).toEqual(v1.edges);
    expect(initCommit.canvas.viewport).toEqual(v1.viewport);
  });

  it("迁移后保留资产数据", () => {
    const v1 = makeV1Project();
    const result = migrateProject(v1);
    const initCommit = result.commits["commit-init"];
    expect(initCommit.assets).toEqual(v1.assets);
  });

  it("迁移后写入 migrationLog", () => {
    const v1 = makeV1Project();
    const result = migrateProject(v1);
    expect(result.migrationLog).toBeDefined();
    expect(result.migrationLog!.length).toBe(1);
    expect(result.migrationLog![0].fromVersion).toBe("1.0");
    expect(result.migrationLog![0].toVersion).toBe("2.0");
  });

  it("v1.x 无 nodes/edges 时使用空对象", () => {
    const result = migrateProject({ version: "1.0", name: "空项目" });
    const initCommit = result.commits["commit-init"];
    expect(initCommit.canvas.nodes).toEqual({});
    expect(initCommit.canvas.edges).toEqual({});
  });

  it("完全无版本号的项目也走迁移", () => {
    const result = migrateProject({ name: "无版本项目" });
    expect(result.version).toBe("2.0");
    expect(result.commits["commit-init"]).toBeDefined();
  });

  it("未知版本格式也走迁移（fallback）", () => {
    const result = migrateProject({ version: "99.0", name: "未来项目" });
    expect(result.version).toBe(Qiji_VERSION);
    expect(result.commits).toBeDefined();
  });

  it("已迁移的 v2.0 项目重复调用幂等", () => {
    const v2 = makeV2Project();
    const first = migrateProject(v2);
    const second = migrateProject(first);
    expect(first).toEqual(second);
  });
});

describe("addMigrationLog", () => {
  it("追加一条迁移日志", () => {
    const project = makeV2Project();
    const updated = addMigrationLog(project, "2.0", "2.1", "测试迁移");
    expect(updated.migrationLog).toHaveLength(1);
    expect(updated.migrationLog![0].description).toBe("测试迁移");
  });

  it("保留已有的迁移日志", () => {
    const project = makeV2Project({
      migrationLog: [
        { fromVersion: "1.0", toVersion: "2.0", migratedAt: "2026-01-01", description: "首次" },
      ],
    });
    const updated = addMigrationLog(project, "2.0", "2.1", "第二次");
    expect(updated.migrationLog).toHaveLength(2);
    expect(updated.migrationLog![0].description).toBe("首次");
    expect(updated.migrationLog![1].description).toBe("第二次");
  });

  it("不修改原项目对象（不可变）", () => {
    const project = makeV2Project();
    addMigrationLog(project, "2.0", "2.1", "不可变测试");
    expect(project.migrationLog).toBeUndefined();
  });
});

describe("Qiji_VERSION 常量", () => {
  it("版本号格式正确", () => {
    expect(Qiji_VERSION).toMatch(/^\d+\.\d+$/);
    expect(Qiji_VERSION).toBe("2.0");
  });
});

describe("CommitSnapshot 结构验证", () => {
  it("初始提交包含必要字段", () => {
    const project = makeV2Project();
    const commit = project.commits["commit-init"] as CommitSnapshot;
    expect(commit.commitId).toBe("commit-init");
    expect(Array.isArray(commit.parentIds)).toBe(true);
    expect(typeof commit.message).toBe("string");
    expect(typeof commit.timestamp).toBe("string");
    expect(commit.canvas).toBeDefined();
    expect(commit.canvas.nodes).toBeDefined();
    expect(commit.canvas.edges).toBeDefined();
    expect(commit.canvas.groups).toBeDefined();
  });
});