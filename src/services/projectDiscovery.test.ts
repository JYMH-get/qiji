import { beforeEach, describe, expect, it, vi } from "vitest";
import { discoverLocalProjects, projectPathKey } from "./projectDiscovery";

const io = vi.hoisted(() => ({ lstat: vi.fn(), readDir: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => io);

type Entry = { name: string; isFile: boolean; isDirectory: boolean; isSymlink: boolean };
type Fixture = { entries?: Entry[]; text?: string; symlink?: boolean; mtime?: Date | null; fail?: "stat" | "directory" | "open" | "read"; chunk?: number };
const fixtures = new Map<string, Fixture>();
const handles: { read: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; bytesRead: number }[] = [];
const root = "D:/fixture/projects";
const mtime = new Date("2026-10-01T05:00:00.000Z");
const savedAt = "2026-10-05T08:09:10.000Z";
const entry = (name: string, directory = false, symlink = false): Entry => ({ name, isFile: !directory, isDirectory: directory, isSymlink: symlink });
function put(path: string, fixture: Fixture) { fixtures.set(projectPathKey(path), fixture); }
function get(path: string): Fixture {
  const fixture = fixtures.get(projectPathKey(path));
  if (!fixture) throw new Error("missing fixture");
  return fixture;
}
function document(name: string) { return JSON.stringify({ version: "2.0", savedAt, name, nodes: {} }); }

beforeEach(() => {
  fixtures.clear(); handles.length = 0;
  vi.resetAllMocks();
  io.lstat.mockImplementation(async (path: string) => {
    const fixture = get(path);
    if (fixture.fail === "stat") throw new Error("stat unavailable");
    return { isDirectory: fixture.entries !== undefined, isFile: fixture.entries === undefined,
      isSymlink: !!fixture.symlink, mtime: fixture.mtime === undefined ? mtime : fixture.mtime };
  });
  io.readDir.mockImplementation(async (path: string) => {
    const fixture = get(path);
    if (fixture.fail === "directory") throw new Error("directory unavailable");
    return fixture.entries;
  });
  io.open.mockImplementation(async (path: string) => {
    const fixture = get(path);
    if (fixture.fail === "open") throw new Error("open unavailable");
    const bytes = new TextEncoder().encode(fixture.text ?? "");
    const handle = { bytesRead: 0, read: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
    handle.read.mockImplementation(async (target: Uint8Array) => {
      if (fixture.fail === "read") throw new Error("read unavailable");
      const count = Math.min(target.length, bytes.length - handle.bytesRead, fixture.chunk ?? Infinity);
      if (!count) return null;
      target.set(bytes.subarray(handle.bytesRead, handle.bytesRead + count));
      handle.bytesRead += count;
      return count;
    });
    handles.push(handle);
    return handle;
  });
});

describe("discoverLocalProjects", () => {
  it("discovers more than ten projects, both directly and in project folders", async () => {
    const entries: Entry[] = [];
    for (let i = 0; i < 13; i++) {
      const folder = `项目${i}_20261005_120000`;
      entries.push(entry(folder, true));
      put(`${root}/${folder}`, { entries: [entry("project.Qiji")] });
      put(`${root}/${folder}/project.Qiji`, { text: document(`项目${i}`) });
    }
    entries.push(entry("Loose.QIJI"));
    put(`${root}/Loose.QIJI`, { text: document("散放项目") });
    put(root, { entries });
    const found = await discoverLocalProjects([root], []);
    expect(found).toHaveLength(14);
    expect(found[0]).toMatchObject({ name: "项目0", openedAt: savedAt });
    expect(found[found.length - 1]?.name).toBe("散放项目");
    expect(handles.every(handle => handle.close.mock.calls.length === 1)).toBe(true);
  });

  it("deduplicates roots and known paths using Windows separators and casing", async () => {
    put(root, { entries: [entry("One.Qiji"), entry("Two.Qiji")] });
    put(`${root}/One.Qiji`, { text: document("one") });
    put(`${root}/Two.Qiji`, { text: document("two") });
    const found = await discoverLocalProjects([root, "d:\\FIXTURE\\PROJECTS\\", `${root}//`], ["d:\\fixture\\projects\\ONE.QIJI"]);
    expect(found.map(project => project.name)).toEqual(["two"]);
    expect(io.readDir).toHaveBeenCalledTimes(1);
    expect(io.open).toHaveBeenCalledTimes(1);
    expect(projectPathKey("\\\\Server\\Share\\project.Qiji")).toBe("//server/share/project.qiji");
  });

  it("continues after missing roots, broken directories and files", async () => {
    put(root, { entries: [entry("broken", true), entry("Removed.Qiji"), entry("Unreadable.Qiji"), entry("ReadFailed.Qiji"), entry("Fine.Qiji")] });
    put(`${root}/broken`, { entries: [], fail: "directory" });
    put(`${root}/Removed.Qiji`, { fail: "stat" });
    put(`${root}/Unreadable.Qiji`, { fail: "open", mtime: null });
    put(`${root}/ReadFailed.Qiji`, { fail: "read" });
    put(`${root}/Fine.Qiji`, { text: document("fine") });
    const found = await discoverLocalProjects(["Z:/missing", root], []);
    expect(found.map(project => project.name)).toEqual(["Unreadable", "ReadFailed", "fine"]);
    expect(found[0].openedAt).toBe(new Date(0).toISOString());
    expect(found[1].openedAt).toBe(mtime.toISOString());
    expect(handles[0].close).toHaveBeenCalledOnce();
  });

  it("ignores backup files, symlinks and deeper asset directories", async () => {
    put(root, { entries: [entry("link", true, true), entry("link.Qiji", false, true), entry("race.Qiji"),
      entry("assets", true), entry("project.Qiji.tmp"), entry("project.Qiji.bak"), entry("Real", true)] });
    put(`${root}/race.Qiji`, { symlink: true });
    put(`${root}/Real`, { entries: [entry("project.Qiji"), entry("assets", true)] });
    put(`${root}/Real/project.Qiji`, { text: document("real") });
    put("D:/linked-projects", { entries: [], symlink: true });
    const found = await discoverLocalProjects(["D:/linked-projects", root], []);
    expect(found.map(project => project.name)).toEqual(["real"]);
    expect(io.readDir.mock.calls.map(([path]) => path)).toEqual([root, `${root}/Real`]);
    expect(io.open).toHaveBeenCalledTimes(1);
  });

  it("handles short byte reads and escaped or multibyte header strings", async () => {
    put(root, { entries: [entry("Short.Qiji")] });
    put(`${root}/Short.Qiji`, { text: document('中文 \\ "标题"'), chunk: 3 });
    const found = await discoverLocalProjects([root], []);
    expect(found[0]).toMatchObject({ name: '中文 \\ "标题"', openedAt: savedAt });
    expect(handles[0].read.mock.calls.length).toBeGreaterThan(10);
  });

  it("never reads beyond 64 KiB, even when the project has a large body", async () => {
    put(root, { entries: [entry("Large.Qiji")] });
    put(`${root}/Large.Qiji`, { text: JSON.stringify({ version: "2.0", savedAt, name: "large", nodes: "x".repeat(200_000) }), chunk: 1023 });
    expect((await discoverLocalProjects([root], []))[0].name).toBe("large");
    expect(handles[0].bytesRead).toBe(64 * 1024);
  });

  it("uses filename or folder fallback for invalid or truncated names and times", async () => {
    put(root, { entries: [entry("根文件.Qiji"), entry("工程_20261005_112233", true), entry("截断.Qiji")] });
    put(`${root}/根文件.Qiji`, { text: "not JSON" });
    put(`${root}/工程_20261005_112233`, { entries: [entry("project.Qiji")] });
    put(`${root}/工程_20261005_112233/project.Qiji`, { text: '{"version":"2.0","savedAt":"invalid","name":' });
    put(`${root}/截断.Qiji`, { text: '{"version":"2.0","savedAt":"2026-10-05T08:09:10Z","name":"unfinished' });
    const found = await discoverLocalProjects([root], []);
    expect(found.map(project => project.name)).toEqual(["根文件", "工程", "截断"]);
    expect(found[1].openedAt).toBe(mtime.toISOString());
    expect(found[2].openedAt).toBe(savedAt);
  });

  it("does not use nested names, including after a header cut inside a nested object", async () => {
    put(root, { entries: [entry("Nested.Qiji"), entry("Cut.Qiji"), entry("Top.Qiji")] });
    put(`${root}/Nested.Qiji`, { text: JSON.stringify({ version: "2.0", nodes: { a: { name: "wrong", savedAt } } }) });
    put(`${root}/Cut.Qiji`, { text: '{"nodes":{"a":{"name":"wrong","savedAt":"2026-10-05T08:09:10Z"' });
    put(`${root}/Top.Qiji`, { text: JSON.stringify({ nodes: { a: { name: "wrong", text: '},"name":"wrong again"' } }, name: "right", savedAt }) });
    const found = await discoverLocalProjects([root], []);
    expect(found.map(project => project.name)).toEqual(["Nested", "Cut", "right"]);
    expect(found[0].openedAt).toBe(mtime.toISOString());
    expect(found[1].openedAt).toBe(mtime.toISOString());
    expect(found[2].openedAt).toBe(savedAt);
  });
});
