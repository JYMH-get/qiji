import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ invoke: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: native.save }));

function desktopWindow() {
  return Object.assign(new EventTarget(), {
    __TAURI_INTERNALS__: {},
    location: { pathname: "/frame-canvas" },
    performance: { memory: { usedJSHeapSize: 1024, totalJSHeapSize: 2048, jsHeapSizeLimit: 4096 } },
  });
}

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.stubGlobal("window", desktopWindow());
  native.invoke.mockResolvedValue(undefined);
  native.save.mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("native diagnostic breadcrumbs", () => {
  it("only forwards enumerated fields and finite nonnegative metrics", async () => {
    const { recordClientDiagnostic } = await import("./clientDiagnostics");
    await recordClientDiagnostic({
      kind: "save_stage", stage: "serialize", source: "autosave", saveId: 4,
      nodeCount: 150, edgeCount: -1, historyCount: Number.NaN, durationMs: 12.6,
      pastCount: 100, futureCount: 2,
      jsonChars: Number.POSITIVE_INFINITY, heapLimitBytes: Number.MAX_SAFE_INTEGER,
      ...({ message: "secret script", projectPath: "C:/private/project.Qiji", url: "https://private/?key=secret" } as object),
    });
    expect(native.invoke).toHaveBeenCalledExactlyOnceWith("record_client_diagnostic", {
      event: { kind: "save_stage", stage: "serialize", source: "autosave", saveId: 4, nodeCount: 150,
        pastCount: 100, futureCount: 2, durationMs: 13, heapUsedBytes: 1024, heapTotalBytes: 2048, heapLimitBytes: 4096 },
    });
  });

  it("samples the current heap at every save stage without copying project data", async () => {
    const target = desktopWindow();
    vi.stubGlobal("window", target);
    const { recordClientDiagnostic } = await import("./clientDiagnostics");
    await recordClientDiagnostic({ kind: "save_start" });
    target.performance.memory.usedJSHeapSize = 3072;
    await recordClientDiagnostic({ kind: "save_serialized", jsonChars: 1500 });
    expect(native.invoke.mock.calls.map(([, args]) => args.event.heapUsedBytes)).toEqual([1024, 3072]);
    target.performance.memory.usedJSHeapSize = Number.MAX_SAFE_INTEGER;
    await recordClientDiagnostic({ kind: "save_success" });
    expect(native.invoke.mock.calls[2][1].event).not.toHaveProperty("heapUsedBytes");
  });

  it("awaits the native acknowledgement before resolving", async () => {
    let acknowledge!: () => void;
    native.invoke.mockReturnValue(new Promise<void>((resolve) => { acknowledge = resolve; }));
    const { recordClientDiagnostic } = await import("./clientDiagnostics");
    let finished = false;
    const record = recordClientDiagnostic({ kind: "save_start" }).then(() => { finished = true; });
    await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledOnce());
    expect(finished).toBe(false);
    acknowledge();
    await record;
    expect(finished).toBe(true);
  });

  it("isolates native failure and resumes after a bounded cooldown", async () => {
    vi.useFakeTimers();
    native.invoke.mockRejectedValueOnce(new Error("private filesystem path"));
    const { recordClientDiagnostic } = await import("./clientDiagnostics");
    await expect(recordClientDiagnostic({ kind: "save_start" })).resolves.toBeUndefined();
    await recordClientDiagnostic({ kind: "save_stage", stage: "serialize" });
    expect(native.invoke).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    await recordClientDiagnostic({ kind: "save_success" });
    expect(native.invoke).toHaveBeenCalledTimes(2);
  });

  it("times out without building an unbounded queue when IPC never settles", async () => {
    vi.useFakeTimers();
    native.invoke.mockImplementation(() => new Promise(() => {}));
    const { recordClientDiagnostic } = await import("./clientDiagnostics");
    for (let i = 0; i < 4; i += 1) {
      const recording = recordClientDiagnostic({ kind: "save_start", saveId: i });
      await vi.advanceTimersByTimeAsync(250);
      await expect(recording).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(30_000);
    }
    await expect(recordClientDiagnostic({ kind: "save_start", saveId: 5 })).resolves.toBeUndefined();
    expect(native.invoke).toHaveBeenCalledTimes(4);
  });

  it("bounds bursts and preserves save capacity during an error storm", async () => {
    vi.useFakeTimers();
    const { recordClientDiagnostic, recordClientError } = await import("./clientDiagnostics");
    for (let i = 0; i < 200; i += 1) await recordClientError(new TypeError("sensitive content"));
    expect(native.invoke).toHaveBeenCalledTimes(10);
    await recordClientDiagnostic({ kind: "save_start" });
    expect(native.invoke).toHaveBeenCalledTimes(11);
    for (let i = 0; i < 100; i += 1) await recordClientDiagnostic({ kind: "save_stage", stage: "write" });
    expect(native.invoke).toHaveBeenCalledTimes(80);
    await vi.advanceTimersByTimeAsync(10_000);
    await recordClientDiagnostic({ kind: "save_success" });
    expect(native.invoke).toHaveBeenCalledTimes(81);
  });

  it("does nothing in a browser and cannot expose arbitrary exception text", async () => {
    vi.stubGlobal("window", { location: { pathname: "/" } });
    const { recordClientDiagnostic, classifyClientDiagnosticError, startClientDiagnostics } = await import("./clientDiagnostics");
    await recordClientDiagnostic({ kind: "save_start" });
    startClientDiagnostics()();
    expect(native.invoke).not.toHaveBeenCalled();
    expect(classifyClientDiagnosticError(new RangeError("user prompt"))).toBe("range_error");
    expect(classifyClientDiagnosticError({ name: "token=secret", message: "script" })).toBe("unknown");
    expect(classifyClientDiagnosticError({ get name() { throw new Error("bad getter"); } })).toBe("unknown");
  });

  it("captures error categories and heap context with removable, duplicate-safe listeners", async () => {
    vi.useFakeTimers();
    const target = window;
    const add = vi.spyOn(target, "addEventListener");
    const remove = vi.spyOn(target, "removeEventListener");
    const { startClientDiagnostics } = await import("./clientDiagnostics");
    const stop = startClientDiagnostics();
    expect(startClientDiagnostics()).toBe(stop);
    expect(add).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    const errorEvent = Object.assign(new Event("error"), {
      error: new TypeError("prompt=secret https://private/?key=secret"),
      filename: "C:/private/file.ts", message: "prompt=secret",
    });
    target.dispatchEvent(errorEvent);
    target.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: "Bearer secret" }));
    await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledTimes(3));
    expect(native.invoke.mock.calls.map(([, args]) => args.event)).toEqual([
      { kind: "context", mode: "canvas", heapUsedBytes: 1024, heapTotalBytes: 2048, heapLimitBytes: 4096 },
      { kind: "frontend_error", errorClass: "type_error", mode: "canvas", heapUsedBytes: 1024, heapTotalBytes: 2048, heapLimitBytes: 4096 },
      { kind: "frontend_error", errorClass: "unknown", mode: "canvas", heapUsedBytes: 1024, heapTotalBytes: 2048, heapLimitBytes: 4096 },
    ]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(native.invoke).toHaveBeenCalledTimes(4);
    stop();
    expect(remove).toHaveBeenCalledTimes(2);
    target.dispatchEvent(errorEvent);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(native.invoke).toHaveBeenCalledTimes(4);
  });
});

describe("diagnostic ZIP export", () => {
  it("treats dialog cancellation as a no-op", async () => {
    const { exportClientDiagnostics } = await import("./clientDiagnostics");
    await expect(exportClientDiagnostics()).resolves.toBeNull();
    expect(native.save).toHaveBeenCalledOnce();
    expect(native.invoke).not.toHaveBeenCalled();
  });

  it("sends only the chosen path to the native streaming export", async () => {
    native.save.mockResolvedValue("D:/support.zip");
    native.invoke.mockResolvedValue("D:/support.zip");
    const { exportClientDiagnostics } = await import("./clientDiagnostics");
    await expect(exportClientDiagnostics()).resolves.toBe("D:/support.zip");
    expect(native.invoke).toHaveBeenCalledExactlyOnceWith("export_client_diagnostics", { path: "D:/support.zip" });
  });

  it("shares one pending export and permits retry after failure", async () => {
    native.save.mockResolvedValue("D:/support.zip");
    native.invoke.mockRejectedValueOnce(new Error("disk full"));
    const { exportClientDiagnostics } = await import("./clientDiagnostics");
    const first = exportClientDiagnostics();
    expect(exportClientDiagnostics()).toBe(first);
    await expect(first).rejects.toThrow("disk full");
    native.invoke.mockResolvedValue("D:/support.zip");
    await expect(exportClientDiagnostics()).resolves.toBe("D:/support.zip");
    expect(native.save).toHaveBeenCalledTimes(2);
  });
});
