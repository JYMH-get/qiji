import { useEffect } from "react";
import { useAccessibilitySettings } from "@/services/accessibilitySettings";

export function AccessibilitySetting() {
  const { settings, loading, saving, error, load, setEnabled } = useAccessibilitySettings();

  useEffect(() => {
    void load();
    // Another Qiji window may have changed the next-start preference.
    const refresh = () => { void load(); };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [load]);

  return (
    <section className="flex flex-col gap-2" aria-labelledby="accessibility-heading">
      <h4 id="accessibility-heading" className="text-xs font-semibold text-foreground">无障碍</h4>
      <div className="bg-secondary/40 border border-border/30 rounded-lg p-3 flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="checkbox"
            role="switch"
            id="client-accessibility"
            checked={settings?.enabled ?? false}
            disabled={!settings?.supported || loading || saving || !!error && !settings}
            onChange={(event) => { void setEnabled(event.target.checked); }}
            aria-describedby="accessibility-effect accessibility-risk accessibility-restart"
            className="h-3.5 w-3.5 rounded accent-[var(--primary)] disabled:opacity-50"
          />
          <label htmlFor="client-accessibility" className="text-foreground text-[11px] cursor-pointer">启用无障碍</label>
          <span className="text-[10px] text-muted-foreground">默认关闭</span>
        </div>
        <p id="accessibility-effect" className="text-[10px] text-muted-foreground leading-relaxed">
          开启后允许读屏软件、取词工具和控件自动化通过无障碍接口读取、操作 Qiji 界面。
          关闭后限制系统无障碍接入，调试工具仍可能读取页面。
        </p>
        <p id="accessibility-risk" className="text-[10px] text-amber-500 leading-relaxed">
          部分环境下可能触发页面卡顿或白屏（STATUS_BREAKPOINT），仅在需要时开启。
        </p>
        <p id="accessibility-restart" className="text-[10px] text-muted-foreground leading-relaxed">
          修改后需关闭全部 Qiji 窗口并重新启动。
        </p>
        <p role="status" aria-live="polite" className="text-[10px] text-muted-foreground">
          {saving ? "正在保存…" : loading ? "正在读取…" : !settings ? "设置尚未读取" : !settings.supported
            ? "此开关仅适用于 Windows 桌面客户端。"
            : settings.restartRequired
              ? `已保存，重启后${settings.enabled ? "开启" : "关闭"}；本次启动设置仍为${settings.activeEnabled ? "开启" : "关闭"}。`
              : `本次启动设置：${settings.activeEnabled ? "已开启" : "已关闭"}`}
        </p>
        {settings?.preferenceReadError && (
          <div className="flex items-center gap-2 text-[10px] text-destructive">
            <p>本机配置读取异常，本次启动状态不变。可重新选择或恢复默认。</p>
            <button type="button" disabled={loading || saving} onClick={() => { void setEnabled(false); }} className="shrink-0 underline cursor-pointer disabled:opacity-50">恢复默认</button>
          </div>
        )}
        {error && (
          <div role="alert" className="flex items-center gap-2 text-[10px] text-destructive">
            <p>{error}</p>
            <button type="button" disabled={loading || saving} onClick={() => { void load(); }} className="shrink-0 underline cursor-pointer disabled:opacity-50">重新读取</button>
          </div>
        )}
      </div>
    </section>
  );
}
