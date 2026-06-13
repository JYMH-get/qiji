import { create } from "zustand";

function isTauri(): boolean {
  return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

async function getTauriFs() {
  const { writeTextFile, readTextFile, exists, mkdir } = await import("@tauri-apps/plugin-fs");
  const { appDataDir, join } = await import("@tauri-apps/api/path");
  return { writeTextFile, readTextFile, exists, mkdir, appDataDir, join };
}

interface SettingsState {
  apiKeys: Record<string, string>;
  defaultModelConfigs: Record<string, string>;
  theme: string;
  language: string;
  lastOpenedProjectPath: string | null;
  userDataDir: string | null;
  initialized: boolean;

  setApiKey: (key: string, val: string) => void;
  setTheme: (theme: string) => void;
  setLanguage: (lang: string) => void;
  setLastOpenedProjectPath: (path: string | null) => void;
  setUserDataDir: (dir: string | null) => void;
  setDefaultModelConfig: (key: string, val: string) => void;
  getActiveUserDataDir: () => Promise<string>;
  init: () => Promise<void>;
  save: () => Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  apiKeys: {},
  defaultModelConfigs: {
    text: "gpt-4o",
    image: "sd-xl",
  },
  theme: "dark",
  language: "zh-CN",
  lastOpenedProjectPath: null,
  userDataDir: null,
  initialized: false,

  setApiKey: (key, val) => {
    set((s) => ({ apiKeys: { ...s.apiKeys, [key]: val } }));
    get().save();
  },
  setTheme: (theme) => {
    set({ theme });
    get().save();
  },
  setLanguage: (language) => {
    set({ language });
    get().save();
  },
  setLastOpenedProjectPath: (lastOpenedProjectPath) => {
    set({ lastOpenedProjectPath });
    get().save();
  },
  setUserDataDir: (userDataDir) => {
    set({ userDataDir });
    get().save();
  },
  setDefaultModelConfig: (key, val) => {
    set((s) => ({ defaultModelConfigs: { ...s.defaultModelConfigs, [key]: val } }));
    get().save();
  },
  getActiveUserDataDir: async () => {
    if (!isTauri()) return "browser";
    const { appDataDir, join } = await getTauriFs();
    const storeDir = get().userDataDir;
    if (storeDir) return storeDir;
    const base = await appDataDir();
    return join(base, "Qiji");
  },

  init: async () => {
    if (get().initialized) return;
    if (!isTauri()) {
      try {
        const stored = localStorage.getItem("Qiji:settings");
        if (stored) {
          const parsed = JSON.parse(stored);
          set({ ...parsed, initialized: true });
        }
      } catch {}
      return;
    }

    try {
      const { readTextFile, exists, appDataDir, join } = await getTauriFs();
      const base = await appDataDir();
      const settingsPath = await join(base, "Qiji", "settings.json");

      if (await exists(settingsPath)) {
        const content = await readTextFile(settingsPath);
        const parsed = JSON.parse(content);
        set({ ...parsed, initialized: true });
      } else {
        set({ initialized: true });
        await get().save();
      }
    } catch (e) {
      console.error("Failed to load settings:", e);
      set({ initialized: true });
    }
  },

  save: async () => {
    const { apiKeys, defaultModelConfigs, theme, language, lastOpenedProjectPath, userDataDir } = get();
    const data = { apiKeys, defaultModelConfigs, theme, language, lastOpenedProjectPath, userDataDir };

    if (!isTauri()) {
      localStorage.setItem("Qiji:settings", JSON.stringify(data));
      return;
    }

    try {
      const { writeTextFile, exists, mkdir, appDataDir, join } = await getTauriFs();
      const base = await appDataDir();
      const qijiDir = await join(base, "Qiji");
      if (!(await exists(qijiDir))) {
        await mkdir(qijiDir, { recursive: true });
      }
      const settingsPath = await join(qijiDir, "settings.json");
      await writeTextFile(settingsPath, JSON.stringify(data, null, 2));
    } catch (e) {
      console.error("Failed to save settings:", e);
    }
  },
}));
