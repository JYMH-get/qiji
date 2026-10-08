import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// SSR normally reads Zustand's initial snapshot. Render the supplied native response
// so this test verifies visible saved/current-session state without mounting effects.
vi.mock("@/services/accessibilitySettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/accessibilitySettings")>();
  const store = actual.useAccessibilitySettings;
  return { ...actual, useAccessibilitySettings: Object.assign(() => store.getState(), store) };
});

import { useAccessibilitySettings } from "@/services/accessibilitySettings";
import { AccessibilitySetting } from "./AccessibilitySetting";

function render() {
  const html = renderToStaticMarkup(<AccessibilitySetting />);
  const input = html.match(/<input\b[^>]*>/)?.[0] ?? "";
  const status = html.match(/<p\b[^>]*role="status"[^>]*>(.*?)<\/p>/)?.[1] ?? "";
  return { html, input, status };
}

beforeEach(() => {
  useAccessibilitySettings.setState({
    settings: { supported: true, enabled: false, activeEnabled: false, restartRequired: false },
    loading: false,
    saving: false,
    error: null,
  });
});

afterEach(() => {
  useAccessibilitySettings.setState({ settings: null, loading: false, saving: false, error: null });
});

describe("无障碍设置显示", () => {
  it("默认关闭，并把能力、崩溃风险与完整重启说明关联到开关", () => {
    const { html, input, status } = render();

    expect(input).toContain('role="switch"');
    expect(input).not.toContain('checked=""');
    expect(input).not.toContain('disabled=""');
    expect(input).toContain('aria-describedby="accessibility-effect accessibility-risk accessibility-restart"');
    expect(status).toBe("本次启动设置：已关闭");
    expect(html).toContain("默认关闭");
    expect(html).toContain("读屏软件、取词工具和控件自动化");
    expect(html).toContain("关闭后限制系统无障碍接入，调试工具仍可能读取页面。");
    expect(html).toContain("页面卡顿或白屏（STATUS_BREAKPOINT）");
    expect(html).toContain("修改后需关闭全部 Qiji 窗口并重新启动。");
  });

  it.each([
    { enabled: true, activeEnabled: false, expected: "已保存，重启后开启；本次启动设置仍为关闭。" },
    { enabled: false, activeEnabled: true, expected: "已保存，重启后关闭；本次启动设置仍为开启。" },
  ])("待重启时分别显示保存偏好 $enabled 和当前进程状态 $activeEnabled", ({ enabled, activeEnabled, expected }) => {
    useAccessibilitySettings.setState({
      settings: { supported: true, enabled, activeEnabled, restartRequired: true },
    });

    const { input, status } = render();

    expect(input.includes('checked=""')).toBe(enabled);
    expect(status).toBe(expected);
  });

  it("初次读取失败时禁用开关并提示重试，不显示保存成功", () => {
    useAccessibilitySettings.setState({ settings: null, error: "无法读取无障碍设置，请重试。" });

    const { html, input, status } = render();

    expect(input).toContain('disabled=""');
    expect(status).toBe("设置尚未读取");
    expect(html).toContain('role="alert"');
    expect(html).toContain("无法读取无障碍设置，请重试。");
    expect(html).toContain("重新读取");
    expect(status).not.toContain("已保存");
    expect(status).not.toContain("本次启动");
  });

  it("本地配置读取异常保留当前启动状态并提供恢复默认入口，不宣称保存成功", () => {
    useAccessibilitySettings.setState({
      settings: {
        supported: true, enabled: false, activeEnabled: false, restartRequired: false,
        preferenceReadError: "invalid local preference",
      },
    });

    const { html, status } = render();

    expect(status).toBe("本次启动设置：已关闭");
    expect(html).toContain("本机配置读取异常，本次启动状态不变。");
    expect(html).toContain("恢复默认");
    expect(status).not.toContain("已保存");
    expect(html).not.toContain("invalid local preference");
  });

  it("正在持久化时显示进行中而不提前宣称已保存", () => {
    useAccessibilitySettings.setState({ saving: true });

    const { input, status } = render();

    expect(input).toContain('disabled=""');
    expect(status).toBe("正在保存…");
    expect(status).not.toContain("已保存");
  });

  it("不支持的环境禁用开关并明确仅适用于 Windows 桌面", () => {
    useAccessibilitySettings.setState({
      settings: { supported: false, enabled: false, activeEnabled: false, restartRequired: false },
    });

    const { input, status } = render();

    expect(input).toContain('disabled=""');
    expect(status).toBe("此开关仅适用于 Windows 桌面客户端。");
  });
});
