import { create } from "zustand";

export interface AccessibilitySettings {
  supported: boolean;
  enabled: boolean;
  activeEnabled: boolean;
  restartRequired: boolean;
  preferenceReadError?: string | null;
}

function isDesktop(): boolean {
  return typeof window !== "undefined"
    && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

/** Pop-outs must use the current process setting, including while a restart is pending. */
export async function getAccessibilityBrowserArgs(): Promise<string> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("get_accessibility_browser_args");
}

interface AccessibilitySettingsState {
  settings: AccessibilitySettings | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  load: () => Promise<void>;
  setEnabled: (enabled: boolean) => Promise<void>;
}

let revision = 0;

export const useAccessibilitySettings = create<AccessibilitySettingsState>((set, get) => ({
  settings: null,
  loading: false,
  saving: false,
  error: null,
  load: async () => {
    if (get().saving) return;
    const request = ++revision;
    if (!isDesktop()) {
      set({ settings: { supported: false, enabled: false, activeEnabled: false, restartRequired: false }, loading: false, error: null });
      return;
    }
    set({ loading: true, error: null });
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const settings = await invoke<AccessibilitySettings>("get_accessibility_settings");
      if (request === revision) set({ settings, error: null });
    } catch {
      if (request === revision) set({ error: "无法读取无障碍设置，请重试。" });
    } finally {
      if (request === revision) set({ loading: false });
    }
  },
  setEnabled: async (enabled) => {
    const current = get();
    if (!isDesktop() || current.saving || current.loading || !current.settings?.supported) return;
    if (enabled === current.settings.enabled && !current.settings.preferenceReadError) return;
    ++revision;
    set({ saving: true, error: null });
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      // Do not show a changed preference or a success message before it is persisted.
      const settings = await invoke<AccessibilitySettings>("set_accessibility_settings", { enabled });
      set({ settings, error: null });
    } catch {
      set({ error: "未能确认无障碍设置已保存，请重新读取后重试。" });
    } finally {
      set({ saving: false });
    }
  },
}));
