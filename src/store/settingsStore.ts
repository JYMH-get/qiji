import { create } from "zustand";

function isTauri(): boolean {
  return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

async function getTauriFs() {
  const { writeTextFile, readTextFile, exists, mkdir } = await import("@tauri-apps/plugin-fs");
  const { appDataDir, join } = await import("@tauri-apps/api/path");
  return { writeTextFile, readTextFile, exists, mkdir, appDataDir, join };
}

/** 渠道定义：一个 API 入口（Base URL + Key + 模型列表） */
export interface Channel {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
}

/** 每类模型的默认配置 */
export interface ModelCategoryDefaults {
  defaultModelId: string; // 格式 "channelId:modelName"
}

/** 每类节点已选中的模型 ID 列表（未选中的不在面板下拉中显示） */
export type SelectedModels = Record<string, string[]>; // key = nodeType

export interface ModelRequestConfig {
  requestType: "default" | "custom";
  method: string;
  url: string;
  headers: Record<string, string>;
  bodyTemplate: string;
}

export interface RequestTemplate {
  id: string;
  name: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  bodyTemplate: string;
}

interface SettingsState {
  apiKeys: Record<string, string>;
  defaultModelConfigs: Record<string, string>;
  theme: string;
  language: string;
  lastOpenedProjectPath: string | null;
  userDataDir: string | null;
  initialized: boolean;
  enableCloudSync: boolean;
  webdavUrl: string;
  webdavDirectory: string;
  webdavUsername: string;
  webdavPassword: string;

  // ── 渠道系统 ──
  channels: Channel[];
  imageDefaults: ModelCategoryDefaults;
  videoDefaults: ModelCategoryDefaults;
  textDefaults: ModelCategoryDefaults;
  audioDefaults: ModelCategoryDefaults;
  /** 每类节点已选中的模型 ID 列表（未选中的不在面板下拉中显示） */
  selectedModels: SelectedModels;
  modelRequests: Record<string, ModelRequestConfig>;
  requestTemplates: RequestTemplate[];

  setApiKey: (key: string, val: string) => void;
  setTheme: (theme: string) => void;
  setLanguage: (lang: string) => void;
  setLastOpenedProjectPath: (path: string | null) => void;
  setUserDataDir: (dir: string | null) => void;
  setDefaultModelConfig: (key: string, val: string) => void;
  setEnableCloudSync: (enabled: boolean) => void;
  setWebdavUrl: (url: string) => void;
  setWebdavDirectory: (dir: string) => void;
  setWebdavUsername: (username: string) => void;
  setWebdavPassword: (password: string) => void;

  // ── 渠道 CRUD ──
  addChannel: (ch: Channel) => void;
  updateChannel: (id: string, patch: Partial<Omit<Channel, "id">>) => void;
  removeChannel: (id: string) => void;
  setChannelModels: (id: string, models: string[]) => void;
  setImageDefaults: (d: ModelCategoryDefaults) => void;
  setVideoDefaults: (d: ModelCategoryDefaults) => void;
  setTextDefaults: (d: ModelCategoryDefaults) => void;
  setAudioDefaults: (d: ModelCategoryDefaults) => void;

  /** 切换某类节点下某个模型的选中状态 */
  toggleSelectedModel: (nodeType: string, modelId: string) => void;

  setModelRequestConfig: (modelId: string, config: ModelRequestConfig) => void;
  addRequestTemplate: (template: RequestTemplate) => void;
  updateRequestTemplate: (id: string, patch: Partial<Omit<RequestTemplate, "id">>) => void;
  removeRequestTemplate: (id: string) => void;

  getActiveUserDataDir: () => Promise<string>;
  init: () => Promise<void>;
  save: () => Promise<void>;
}

let _idCounter = 0;
function genChannelId(): string {
  _idCounter++;
  return `ch-${Date.now()}-${_idCounter}`;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  apiKeys: {},
  defaultModelConfigs: { text: "gpt-4o", image: "sd-xl" },
  theme: "dark",
  language: "zh-CN",
  lastOpenedProjectPath: null,
  userDataDir: null,
  initialized: false,
  enableCloudSync: false,
  webdavUrl: "",
  webdavDirectory: "",
  webdavUsername: "",
  webdavPassword: "",

  channels: [],
  imageDefaults: { defaultModelId: "" },
  videoDefaults: { defaultModelId: "" },
  textDefaults: { defaultModelId: "" },
  audioDefaults: { defaultModelId: "" },
  selectedModels: { image: [], video: [], text: [], audio: [] },
  modelRequests: {},
  requestTemplates: [],

  setApiKey: (key, val) => {
    set((s) => ({ apiKeys: { ...s.apiKeys, [key]: val } }));
    get().save();
  },
  setTheme: (theme) => { set({ theme }); get().save(); },
  setLanguage: (language) => { set({ language }); get().save(); },
  setLastOpenedProjectPath: (lastOpenedProjectPath) => { set({ lastOpenedProjectPath }); get().save(); },
  setUserDataDir: (userDataDir) => { set({ userDataDir }); get().save(); },
  setDefaultModelConfig: (key, val) => {
    set((s) => ({ defaultModelConfigs: { ...s.defaultModelConfigs, [key]: val } }));
    get().save();
  },
  setEnableCloudSync: (enableCloudSync) => { set({ enableCloudSync }); get().save(); },
  setWebdavUrl: (webdavUrl) => { set({ webdavUrl }); get().save(); },
  setWebdavDirectory: (webdavDirectory) => { set({ webdavDirectory }); get().save(); },
  setWebdavUsername: (webdavUsername) => { set({ webdavUsername }); get().save(); },
  setWebdavPassword: (webdavPassword) => { set({ webdavPassword }); get().save(); },

  // ── 渠道 CRUD ──
  addChannel: (ch) => {
    set((s) => ({ channels: [...s.channels, ch] }));
    get().save();
  },
  updateChannel: (id, patch) => {
    set((s) => ({
      channels: s.channels.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    }));
    get().save();
  },
  removeChannel: (id) => {
    set((s) => ({ channels: s.channels.filter((c) => c.id !== id) }));
    get().save();
  },
  setChannelModels: (id, models) => {
    set((s) => ({
      channels: s.channels.map((c) => (c.id === id ? { ...c, models } : c)),
    }));
    get().save();
  },
  setImageDefaults: (d) => { set({ imageDefaults: d }); get().save(); },
  setVideoDefaults: (d) => { set({ videoDefaults: d }); get().save(); },
  setTextDefaults: (d) => { set({ textDefaults: d }); get().save(); },
  setAudioDefaults: (d) => { set({ audioDefaults: d }); get().save(); },

  toggleSelectedModel: (nodeType, modelId) => {
    set((s) => {
      const cur = s.selectedModels[nodeType] ?? [];
      const next = cur.includes(modelId) ? cur.filter((x) => x !== modelId) : [...cur, modelId];
      return { selectedModels: { ...s.selectedModels, [nodeType]: next } };
    });
    get().save();
  },

  setModelRequestConfig: (modelId, config) => {
    set((s) => ({ modelRequests: { ...s.modelRequests, [modelId]: config } }));
    get().save();
  },
  addRequestTemplate: (template) => {
    set((s) => ({ requestTemplates: [...s.requestTemplates, template] }));
    get().save();
  },
  updateRequestTemplate: (id, patch) => {
    set((s) => ({
      requestTemplates: s.requestTemplates.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    }));
    get().save();
  },
  removeRequestTemplate: (id) => {
    set((s) => ({ requestTemplates: s.requestTemplates.filter((t) => t.id !== id) }));
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
          set({
            modelRequests: {},
            requestTemplates: [],
            ...parsed,
            initialized: true
          });
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
        set({
          modelRequests: {},
          requestTemplates: [],
          ...parsed,
          initialized: true
        });
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
    const state = get();
    const data = {
      apiKeys: state.apiKeys,
      defaultModelConfigs: state.defaultModelConfigs,
      theme: state.theme,
      language: state.language,
      lastOpenedProjectPath: state.lastOpenedProjectPath,
      userDataDir: state.userDataDir,
      enableCloudSync: state.enableCloudSync,
      webdavUrl: state.webdavUrl,
      webdavDirectory: state.webdavDirectory,
      webdavUsername: state.webdavUsername,
      webdavPassword: state.webdavPassword,
      channels: state.channels,
      imageDefaults: state.imageDefaults,
      videoDefaults: state.videoDefaults,
      textDefaults: state.textDefaults,
      audioDefaults: state.audioDefaults,
      selectedModels: state.selectedModels,
      modelRequests: state.modelRequests,
      requestTemplates: state.requestTemplates,
    };

    if (!isTauri()) {
      localStorage.setItem("Qiji:settings", JSON.stringify(data));
      return;
    }
    try {
      const { writeTextFile, exists, mkdir, appDataDir, join } = await getTauriFs();
      const base = await appDataDir();
      const qijiDir = await join(base, "Qiji");
      if (!(await exists(qijiDir))) await mkdir(qijiDir, { recursive: true });
      const settingsPath = await join(qijiDir, "settings.json");
      await writeTextFile(settingsPath, JSON.stringify(data, null, 2));
    } catch (e) {
      console.error("Failed to save settings:", e);
    }
  },
}));

/** 从 channels 列表中拉取 OpenAI 兼容模型列表 */
export async function fetchModelsFromChannel(baseUrl: string, apiKey: string): Promise<string[]> {
  const url = baseUrl.replace(/\/+$/, "") + "/v1/models";
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
  const json = await resp.json();
  const data = json.data ?? json;
  if (!Array.isArray(data)) throw new Error("响应格式异常：data 不是数组");
  return data.map((m: any) => m.id ?? m.name ?? String(m)).filter(Boolean).sort();
}

export { genChannelId };
