import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccessibilitySettings } from "./accessibilitySettings";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
const off: AccessibilitySettings = { supported: true, enabled: false, activeEnabled: false, restartRequired: false };
const pending: AccessibilitySettings = { ...off, enabled: true, restartRequired: true };

async function loaded(settings = off) {
  native.invoke.mockResolvedValueOnce(settings);
  const { useAccessibilitySettings } = await import("./accessibilitySettings");
  await useAccessibilitySettings.getState().load();
  return useAccessibilitySettings;
}

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
});
afterEach(() => vi.unstubAllGlobals());

describe("desktop accessibility preference", () => {
  it("keeps browser preview unsupported and never changes the host browser", async () => {
    vi.stubGlobal("window", {});
    const { useAccessibilitySettings: store } = await import("./accessibilitySettings");
    await store.getState().load();
    await store.getState().setEnabled(true);
    expect(store.getState().settings).toEqual({ ...off, supported: false });
    expect(native.invoke).not.toHaveBeenCalled();
  });

  it("waits for persistence before displaying a changed setting and keeps active off", async () => {
    const store = await loaded();
    let acknowledge!: (value: AccessibilitySettings) => void;
    native.invoke.mockReturnValueOnce(new Promise((resolve) => { acknowledge = resolve; }));
    const save = store.getState().setEnabled(true);
    await vi.waitFor(() => expect(native.invoke).toHaveBeenLastCalledWith("set_accessibility_settings", { enabled: true }));
    expect(store.getState().saving).toBe(true);
    expect(store.getState().settings).toEqual(off);
    await store.getState().setEnabled(true);
    await store.getState().load();
    expect(native.invoke).toHaveBeenCalledTimes(2);
    acknowledge(pending);
    await save;
    expect(store.getState().settings).toEqual(pending);
    expect(store.getState().saving).toBe(false);
  });

  it("does not report success or change the switch when persistence fails", async () => {
    const store = await loaded();
    native.invoke.mockRejectedValueOnce(new Error("private filesystem path"));
    await store.getState().setEnabled(true);
    expect(store.getState().settings).toEqual(off);
    expect(store.getState().error).toContain("重新读取");
    expect(store.getState().error).not.toContain("private");
    expect(store.getState().saving).toBe(false);
    native.invoke.mockResolvedValueOnce(pending);
    await store.getState().load();
    expect(store.getState().settings).toEqual(pending);
    expect(store.getState().error).toBeNull();
  });

  it("cannot write until the native setting has loaded successfully", async () => {
    native.invoke.mockRejectedValueOnce(new Error("read failed"));
    const { useAccessibilitySettings: store } = await import("./accessibilitySettings");
    await store.getState().load();
    await store.getState().setEnabled(true);
    expect(store.getState().settings).toBeNull();
    expect(store.getState().error).toContain("无法读取");
    expect(native.invoke).toHaveBeenCalledTimes(1);
  });

  it("ignores an older read after another window preference refresh completes", async () => {
    const store = await loaded();
    let oldRead!: (value: AccessibilitySettings) => void;
    native.invoke.mockReturnValueOnce(new Promise((resolve) => { oldRead = resolve; }));
    const first = store.getState().load();
    await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledTimes(2));
    native.invoke.mockResolvedValueOnce(pending);
    await store.getState().load();
    oldRead(off);
    await first;
    expect(store.getState().settings).toEqual(pending);
    expect(store.getState().loading).toBe(false);
  });

  it("allows restoring a corrupt preference even when its fallback is already off", async () => {
    const store = await loaded({ ...off, preferenceReadError: "invalid JSON" });
    native.invoke.mockResolvedValueOnce(off);
    await store.getState().setEnabled(false);
    expect(native.invoke).toHaveBeenLastCalledWith("set_accessibility_settings", { enabled: false });
    expect(store.getState().settings).toEqual(off);
  });

  it("cancels the pending restart when the saved choice matches this process again", async () => {
    const store = await loaded(pending);
    native.invoke.mockResolvedValueOnce(off);
    await store.getState().setEnabled(false);
    expect(store.getState().settings?.restartRequired).toBe(false);
    await store.getState().setEnabled(false);
    expect(native.invoke).toHaveBeenCalledTimes(2);
  });
});
