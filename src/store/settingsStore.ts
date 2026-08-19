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

/**
 * 视频/分镜表格的列宽 + 行高（全局，跨分集/跨项目共用，持久化到 settings.json）。
 * 列序与表头一致：操作 / 原文分段 / 素材 / 提示词 / 故事板 / 视频。
 * 一旦用户拖动调整即固定（内容不再自动撑开），不改则一直沿用。
 */
export interface VideoTableLayout {
  colWidths: number[]; // 6 列，px
  rowHeight: number;   // 行高，px（所有行统一）
}
export const DEFAULT_VIDEO_TABLE_LAYOUT: VideoTableLayout = {
  colWidths: [160, 320, 140, 340, 240, 280],
  rowHeight: 260,
};

/** 已保存的表格样式模板（命名快照，可一键切换列宽/行高） */
export interface VideoTableTemplate {
  id: string;
  name: string;
  layout: VideoTableLayout;
}

/** 画布「整理」的默认纵向节点间距（高度方向，px）；用户可在 设置→快捷键 页自定义 */
export const DEFAULT_TIDY_ROW_GAP = 48;
export function normalizeTidyRowGap(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return DEFAULT_TIDY_ROW_GAP;
  return Math.min(400, Math.max(0, Math.round(n)));
}

/** 用户自定义出图预设方案（客户端本地，与服务端「预设方案」模板并列出现在图片节点预设下拉/胶囊里） */
export interface CustomPreset {
  id: string;
  name: string;
  body: string;
  /** 互斥组（规则）：同组预设不能同时出现在一段提示词里；填「宫格」可与内置宫格预设互斥。空=无互斥 */
  group?: string;
  /** 默认插入位置：前缀（用户输入前）/后缀（用户输入后）；缺省=前缀 */
  position?: "prefix" | "suffix";
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
  modelRequests: Record<string, ModelRequestConfig>;
  requestTemplates: RequestTemplate[];

  /** 视频表格列宽/行高（全局共享，跨分集/项目） */
  videoTableLayout: VideoTableLayout;
  /** 已保存的表格样式模板（命名快照，可一键切换） */
  videoTableTemplates: VideoTableTemplate[];

  /** 用户自定义出图预设方案（本地，图片节点预设下拉/胶囊里与服务端预设并列） */
  customPresets: CustomPreset[];

  /** 画布快捷键用户覆盖：actionId → 规范化组合串（见 src/canvas/keymap.ts；缺省=各动作默认键） */
  canvasKeymap: Record<string, string>;

  /** 画布「整理」的纵向节点间距（高度方向，px；默认 DEFAULT_TIDY_ROW_GAP） */
  tidyRowGap: number;

  /** 转深度等本地推理是否启用 GPU（WebGPU）加速；false=强制 WASM CPU（兼容性兜底）。默认开。 */
  depthGpu: boolean;

  /** 视频转深度归一化模式：true=时间平滑（相邻帧标定范围指数平滑，防闪烁；默认）/ false=每帧独立（与图片同逻辑） */
  depthVideoSmooth: boolean;

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

  setModelRequestConfig: (modelId: string, config: ModelRequestConfig) => void;
  addRequestTemplate: (template: RequestTemplate) => void;
  updateRequestTemplate: (id: string, patch: Partial<Omit<RequestTemplate, "id">>) => void;
  removeRequestTemplate: (id: string) => void;

  /**
   * 更新视频表格布局。拖动过程中传 persist=false 只更新内存（避免每像素写盘），
   * 拖动结束再调一次 save() 落盘。
   */
  setVideoTableLayout: (patch: Partial<VideoTableLayout>, persist?: boolean) => void;
  resetVideoTableLayout: () => void;
  /** 把当前表格布局保存为命名模板，返回新模板 id */
  saveVideoTableTemplate: (name: string) => string;
  /** 套用某个表格模板（写入当前布局并落盘） */
  applyVideoTableTemplate: (id: string) => void;
  /** 删除某个表格模板 */
  removeVideoTableTemplate: (id: string) => void;

  /** 改绑某个画布快捷键（combo 传空串=恢复该动作默认） */
  setKeymapBinding: (actionId: string, combo: string) => void;
  /** 全部恢复默认快捷键 */
  resetKeymap: () => void;
  /** 设置画布「整理」的纵向节点间距（自动收敛到 0~400 整数） */
  setTidyRowGap: (gap: number) => void;
  /** 开关本地推理 GPU 加速（转深度）；对下一次转深度生效 */
  setDepthGpu: (enabled: boolean) => void;
  /** 切换视频转深度归一化模式（时间平滑/每帧独立）；对下一次视频转深度生效 */
  setDepthVideoSmooth: (enabled: boolean) => void;

  /** 新增自定义预设（返回新 id）；group=互斥组、position=前缀/后缀（可选） */
  addCustomPreset: (name: string, body: string, group?: string, position?: "prefix" | "suffix") => string;
  /** 修改自定义预设 */
  updateCustomPreset: (id: string, patch: Partial<Omit<CustomPreset, "id">>) => void;
  /** 删除自定义预设 */
  removeCustomPreset: (id: string) => void;

  getActiveUserDataDir: () => Promise<string>;
  init: () => Promise<void>;
  save: () => Promise<void>;
}

/** 兜底校验从磁盘读到的表格布局；缺失/列数不符/非法数值 → 回退默认 */
function normalizeVideoTableLayout(v: unknown): VideoTableLayout {
  const def = DEFAULT_VIDEO_TABLE_LAYOUT;
  const o = v as Partial<VideoTableLayout> | undefined;
  const ok =
    o &&
    Array.isArray(o.colWidths) &&
    o.colWidths.length === def.colWidths.length &&
    o.colWidths.every((n) => typeof n === "number" && n > 0) &&
    typeof o.rowHeight === "number" &&
    o.rowHeight > 0;
  return ok
    ? { colWidths: [...(o!.colWidths as number[])], rowHeight: o!.rowHeight as number }
    : { ...def, colWidths: [...def.colWidths] };
}

/** 兜底校验从磁盘读到的快捷键覆盖表：非对象/值非字符串 → 丢弃 */
function normalizeKeymap(v: unknown): Record<string, string> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string" && val) out[k] = val;
  }
  return out;
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
  modelRequests: {},
  requestTemplates: [],
  videoTableLayout: { ...DEFAULT_VIDEO_TABLE_LAYOUT, colWidths: [...DEFAULT_VIDEO_TABLE_LAYOUT.colWidths] },
  videoTableTemplates: [],
  customPresets: [],
  canvasKeymap: {},
  tidyRowGap: DEFAULT_TIDY_ROW_GAP,
  depthGpu: true,
  depthVideoSmooth: true,

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

  setVideoTableLayout: (patch, persist = true) => {
    set((s) => ({ videoTableLayout: { ...s.videoTableLayout, ...patch } }));
    if (persist) get().save();
  },
  resetVideoTableLayout: () => {
    set({ videoTableLayout: { ...DEFAULT_VIDEO_TABLE_LAYOUT, colWidths: [...DEFAULT_VIDEO_TABLE_LAYOUT.colWidths] } });
    get().save();
  },
  saveVideoTableTemplate: (name) => {
    const id = `vtt-${Date.now()}-${++_idCounter}`;
    const cur = get().videoTableLayout;
    const tpl: VideoTableTemplate = { id, name: name.trim() || `布局${get().videoTableTemplates.length + 1}`, layout: { colWidths: [...cur.colWidths], rowHeight: cur.rowHeight } };
    set((s) => ({ videoTableTemplates: [...s.videoTableTemplates, tpl] }));
    get().save();
    return id;
  },
  applyVideoTableTemplate: (id) => {
    const tpl = get().videoTableTemplates.find((t) => t.id === id);
    if (!tpl) return;
    set({ videoTableLayout: { colWidths: [...tpl.layout.colWidths], rowHeight: tpl.layout.rowHeight } });
    get().save();
  },
  removeVideoTableTemplate: (id) => {
    set((s) => ({ videoTableTemplates: s.videoTableTemplates.filter((t) => t.id !== id) }));
    get().save();
  },

  setKeymapBinding: (actionId, combo) => {
    set((s) => {
      const next = { ...s.canvasKeymap };
      if (combo) next[actionId] = combo;
      else delete next[actionId]; // 空串=清除覆盖，回到默认
      return { canvasKeymap: next };
    });
    get().save();
  },
  resetKeymap: () => {
    set({ canvasKeymap: {} });
    get().save();
  },
  setTidyRowGap: (gap) => {
    set({ tidyRowGap: normalizeTidyRowGap(gap) });
    get().save();
  },
  setDepthGpu: (depthGpu) => {
    set({ depthGpu: depthGpu !== false });
    get().save();
  },
  setDepthVideoSmooth: (depthVideoSmooth) => {
    set({ depthVideoSmooth: depthVideoSmooth !== false });
    get().save();
  },

  addCustomPreset: (name, body, group, position) => {
    const id = `preset.custom.${Date.now()}.${++_idCounter}`;
    const p: CustomPreset = { id, name: name.trim() || `自定义预设${get().customPresets.length + 1}`, body, group: group?.trim() || undefined, position: position === "suffix" ? "suffix" : "prefix" };
    set((s) => ({ customPresets: [...s.customPresets, p] }));
    get().save();
    return id;
  },
  updateCustomPreset: (id, patch) => {
    set((s) => ({ customPresets: s.customPresets.map((p) => (p.id === id ? { ...p, ...patch } : p)) }));
    get().save();
  },
  removeCustomPreset: (id) => {
    set((s) => ({ customPresets: s.customPresets.filter((p) => p.id !== id) }));
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
          // 第132轮删除「启用模型」子集与四能力默认模型概念，存量残留不再入 state
          delete parsed.selectedModels;
          delete parsed.imageDefaults; delete parsed.videoDefaults; delete parsed.textDefaults; delete parsed.audioDefaults;
          set({
            modelRequests: {},
            requestTemplates: [],
            ...parsed,
            videoTableLayout: normalizeVideoTableLayout(parsed.videoTableLayout),
            videoTableTemplates: Array.isArray(parsed.videoTableTemplates) ? parsed.videoTableTemplates : [],
            customPresets: Array.isArray(parsed.customPresets) ? parsed.customPresets : [],
            canvasKeymap: normalizeKeymap(parsed.canvasKeymap),
            tidyRowGap: normalizeTidyRowGap(parsed.tidyRowGap),
            depthGpu: parsed.depthGpu !== false,
            depthVideoSmooth: parsed.depthVideoSmooth !== false,
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
        // 第132轮删除「启用模型」子集与四能力默认模型概念，存量残留不再入 state
        delete parsed.selectedModels;
        delete parsed.imageDefaults; delete parsed.videoDefaults; delete parsed.textDefaults; delete parsed.audioDefaults;
        set({
          modelRequests: {},
          requestTemplates: [],
          ...parsed,
          videoTableLayout: normalizeVideoTableLayout(parsed.videoTableLayout),
          videoTableTemplates: Array.isArray(parsed.videoTableTemplates) ? parsed.videoTableTemplates : [],
          canvasKeymap: normalizeKeymap(parsed.canvasKeymap),
          tidyRowGap: normalizeTidyRowGap(parsed.tidyRowGap),
          depthGpu: parsed.depthGpu !== false,
          depthVideoSmooth: parsed.depthVideoSmooth !== false,
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
      modelRequests: state.modelRequests,
      requestTemplates: state.requestTemplates,
      videoTableLayout: state.videoTableLayout,
      videoTableTemplates: state.videoTableTemplates,
      customPresets: state.customPresets,
      canvasKeymap: state.canvasKeymap,
      tidyRowGap: state.tidyRowGap,
      depthGpu: state.depthGpu,
      depthVideoSmooth: state.depthVideoSmooth,
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
