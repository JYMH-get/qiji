import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  invoke: vi.fn(),
  getByLabel: vi.fn(),
  createWindow: vi.fn(),
  once: vi.fn(),
  focus: vi.fn(),
  open: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: class {
    static getByLabel = native.getByLabel;
    once = native.once;
    constructor(label: string, options: unknown) {
      native.createWindow(label, options);
    }
  },
}));

import { useAccessibilitySettings } from "@/services/accessibilitySettings";
import { openPopout } from "./popout";

beforeEach(() => {
  vi.clearAllMocks();
  native.getByLabel.mockResolvedValue(null);
  native.focus.mockResolvedValue(undefined);
  native.invoke.mockResolvedValue("--disable-features=msEdgeSidebarV2 --disable-renderer-accessibility");
  vi.stubGlobal("window", {
    __TAURI_INTERNALS__: {},
    location: { pathname: "/workspace", search: "" },
    open: native.open,
  });
  useAccessibilitySettings.setState({
    settings: { supported: true, enabled: true, activeEnabled: false, restartRequired: true },
    loading: false,
    saving: false,
    error: null,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  useAccessibilitySettings.setState({ settings: null, loading: false, saving: false, error: null });
});

describe("助手弹窗无障碍启动参数", () => {
  it.each(["jianyi", "asset"] as const)("%s 使用原生当前进程参数，而不提前应用待重启的开启偏好", async (which) => {
    await openPopout(which);

    expect(native.invoke).toHaveBeenCalledExactlyOnceWith("get_accessibility_browser_args");
    expect(native.getByLabel).toHaveBeenCalledExactlyOnceWith(`popout-${which}`);
    expect(native.createWindow).toHaveBeenCalledExactlyOnceWith(`popout-${which}`, expect.objectContaining({
      url: `/workspace?popout=${which}`,
      additionalBrowserArgs: "--disable-features=msEdgeSidebarV2 --disable-renderer-accessibility",
    }));
    expect(native.open).not.toHaveBeenCalled();
  });

  it("待重启关闭时仍采用原生返回的当前开启参数，且逐字保留额外参数", async () => {
    useAccessibilitySettings.setState({
      settings: { supported: true, enabled: false, activeEnabled: true, restartRequired: true },
    });
    const frozenArgs = "--disable-features=msEdgeSidebarV2 --native-session-argument=test";
    native.invoke.mockResolvedValue(frozenArgs);

    await openPopout("jianyi");

    expect(native.invoke).toHaveBeenCalledExactlyOnceWith("get_accessibility_browser_args");
    expect(native.createWindow).toHaveBeenCalledWith("popout-jianyi", expect.objectContaining({
      additionalBrowserArgs: frozenArgs,
    }));
  });

  it("已有助手窗只聚焦，不读取参数或新建窗口", async () => {
    native.getByLabel.mockResolvedValue({ setFocus: native.focus });

    await openPopout("asset");

    expect(native.focus).toHaveBeenCalledOnce();
    expect(native.invoke).not.toHaveBeenCalled();
    expect(native.createWindow).not.toHaveBeenCalled();
    expect(native.open).not.toHaveBeenCalled();
  });

  it("浏览器直接开新标签页，不访问原生命令或 WebviewWindow", async () => {
    vi.stubGlobal("window", {
      location: { pathname: "/workspace", search: "" },
      open: native.open,
    });

    await openPopout("asset");

    expect(native.open).toHaveBeenCalledExactlyOnceWith("/workspace?popout=asset", "_blank", "noopener");
    expect(native.invoke).not.toHaveBeenCalled();
    expect(native.getByLabel).not.toHaveBeenCalled();
    expect(native.createWindow).not.toHaveBeenCalled();
  });
});
