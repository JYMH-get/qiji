/**
 * projectStore.ts — 项目元数据与文件 I/O 状态
 * 提交历史管理已拆分至 commitStore
 */
import { create } from "zustand";
import { useCanvasStore } from "./canvasStore";
import { sanitizeCanvas } from "@/nodes/nodeSpecs";
import { useLibraryStore } from "./libraryStore";
import { useCommitStore, createInitialCommits } from "./commitStore";
import type { QijiProject, ProjectModelConfig, AssetVariantLite, VideoEpisode, StoryboardShot, PendingGen, InferTask, AssetBlob, MediaSettings, UiSnapshot, GenMeta, RefImgMemo, CanvasData } from "@/services/projectFile";
import type { RtcDoc } from "@/types/rtc";
import { toPortableProjectData } from "@/lib/portableProject";
import { sanitizeAssetBlobs, mergeAssetBlob, blobMatchesUri } from "@/lib/blobSanitize";
import { collectLocalRefs, applyRefRewrites, fileNameOf } from "@/lib/importCopy";
import { useSettingsStore } from "./settingsStore";
import { isProjectWriter } from "@/services/windowSync";

/** 多画布：每个分集 = 一块画布，key = 分集 id（无主画布；项目恒有≥1集）。 */
/** 解析「激活分集 key」（画布与实时剪辑共用一把尺）：目标集无效/为 null 则回退第一集 */
export function resolveEpisodeKey(episodeId: string | null, episodes: VideoEpisode[]): string {
  if (episodeId && episodes.some((e) => e.id === episodeId)) return episodeId;
  return episodes[0]?.id ?? "";
}
/** 解析当前激活画布 key（= 有效分集 id）：当前集无效则回退第一集 */
const resolveCanvasKey = resolveEpisodeKey;
/** 实时剪辑：当前激活分集的剪辑文档（无则 null）。引用稳定可作 zustand selector。 */
export function activeRtcProjectDoc(s: Pick<ProjectState, "rtcDocs" | "rtcEpisodeId" | "episodes">): RtcDoc | null {
  return s.rtcDocs[resolveEpisodeKey(s.rtcEpisodeId, s.episodes)] ?? null;
}
/** 默认第一集（项目至少保留一集；空项目/旧无分集项目自动补） */
function makeFirstEpisode(): VideoEpisode {
  return { id: `ep-${Date.now()}-${Math.floor(Math.random() * 1000)}`, index: 1, title: "001-第一集", scriptText: "", shots: [] };
}
/** 保证 episodes 非空：空则补一集第一集 */
function ensureEpisodes(episodes: VideoEpisode[] | undefined): VideoEpisode[] {
  return episodes && episodes.length > 0 ? episodes : [makeFirstEpisode()];
}
/** 实时剪辑分集档位加载：新字段 rtcDocs 优先；旧单文档 rtcDoc（分集化前）迁入第一集档位 */
function migrateRtcDocs(project: Pick<QijiProject, "rtcDoc" | "rtcDocs">, episodes: VideoEpisode[]): Record<string, RtcDoc> {
  const docs = project.rtcDocs && Object.keys(project.rtcDocs).length ? { ...project.rtcDocs } : {};
  if (Object.keys(docs).length === 0 && project.rtcDoc && episodes[0]) docs[episodes[0].id] = project.rtcDoc;
  return docs;
}
/** 快照当前活动画布（canvasStore）为 CanvasData */
function snapshotActiveCanvas(): CanvasData {
  const c = useCanvasStore.getState();
  return { nodes: c.nodes, edges: c.edges, groups: c.groups, viewport: c.viewport };
}

/** 新项目「视频设置」默认值：图像 16:9 / 2K，视频 16:9 / 720p */
export const DEFAULT_MEDIA_SETTINGS: MediaSettings = {
  maxDuration: 15,
  shotCount: 0,
  imageAspect: "16:9",
  imageResolution: "2K",
  imageQuality: "high",
  resolution: "720p",
  aspect: "16:9",
  genWithAsset: true,
  genWithStory: false,
};
/** 新项目界面快照默认值：空（无历史位置，按各界面自身默认落地） */
export const DEFAULT_UI_SNAPSHOT: UiSnapshot = {};
import { initDebouncedSave, scheduleSave, notifySaved } from "./debouncedSave";
import { stripHeavyRefs } from "@/lib/stripHeavyRefs";

function isTauri(): boolean {
  return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

/**
 * 把文件数据强制刷到物理磁盘（fsync）。原子保存写完 .tmp、rename 生效前必须调用它——
 * 否则 writeTextFile 只进系统写回缓存，断电会让主文件与 .bak 同时清零（实测事故根因）。
 * best-effort：fsync 失败（旧壳无此命令等）不阻断保存，退回原行为。
 */
async function fsyncQuiet(path: string): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("fsync_file", { path });
  } catch (e) {
    console.warn("[project] fsync 跳过（不影响保存）:", e);
  }
}

/**
 * 项目实例标识（运行态、非持久化）：每次 新建/加载/导入 项目都换一个全新值，
 * 唯一标识「当前内存里加载的是哪一份项目」。直写型在途任务（剧本分析等）在提交时
 * 捕获它，回调写库前比对——不一致说明用户已切到别的项目，直接放弃落库，杜绝跨项目串台。
 * （savePath 对未保存的新项目为 null、无法区分两个新项目，故另设此运行态 id。）
 */
function newInstanceId(): string {
  return `pi-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function getNewProjectPath(projectName: string): Promise<{ folderPath: string; filePath: string }> {
  const settings = useSettingsStore.getState();
  const userDataDir = await settings.getActiveUserDataDir();
  const { join } = await import("@tauri-apps/api/path");

  const now = new Date();
  const timestamp = now.getFullYear() +
    String(now.getMonth() + 1).padStart(2, "0") +
    String(now.getDate()).padStart(2, "0") +
    "_" +
    String(now.getHours()).padStart(2, "0") +
    String(now.getMinutes()).padStart(2, "0") +
    String(now.getSeconds()).padStart(2, "0");

  const cleanName = projectName.replace(/[\\/:*?"<>|]/g, "_");
  const folderName = `${cleanName}_${timestamp}`;

  const folderPath = await join(userDataDir, "projects", folderName);
  const filePath = await join(folderPath, "project.Qiji");
  return { folderPath, filePath };
}

async function normalizeProjectAssets(project: QijiProject, assetsDir: string) {
  if (!isTauri()) return;

  const { convertFileSrc } = await import("@tauri-apps/api/core");
  const cleanAssetsDir = assetsDir.replace(/\\/g, "/");

  if (project.files) {
    for (const key of Object.keys(project.files)) {
      const oldPath = project.files[key];
      if (oldPath) {
        const filename = oldPath.split(/[/\\]/).pop() || "";
        project.files[key] = `${cleanAssetsDir}/${filename}`;
      }
    }
  }

  if (project.commits) {
    for (const commitId of Object.keys(project.commits)) {
      const commit = project.commits[commitId];
      if (commit.assets) {
        for (const assetId of Object.keys(commit.assets)) {
          const asset = commit.assets[assetId];
          if (asset && asset.localPath) {
            const filename = asset.localPath.split(/[/\\]/).pop() || "";
            const newPath = `${cleanAssetsDir}/${filename}`;
            asset.localPath = newPath;
            asset.uri = convertFileSrc(newPath);
          }
        }
      }
    }
  }
}

/**
 * 导入 .Qiji 为**新项目**（Tauri 路径）：新建项目文件夹 → 把 JSON 里引用到的本地素材复制进
 * 新项目 assets/ → 本地引用改写为新路径 → 落盘 → 打开。源文件与源项目全程只读分毫不动
 * （第173轮用户定：导入不影响被导入的文件，是新建项目并复制文件导入）。
 * 本地文件缺失/复制失败的引用保持原样——打开后凭公网 url 走既有自愈（与跨设备导入同路径）。
 * 返回是否成功打开新项目。
 */
async function importAsNewProject(srcPath: string): Promise<boolean> {
  const { readTextFile, writeTextFile, exists, mkdir, copyFile } = await import("@tauri-apps/plugin-fs");
  const { join } = await import("@tauri-apps/api/path");
  const { convertFileSrc } = await import("@tauri-apps/api/core");

  // 读源文件（主文件损坏时按 .tmp/.bak 兜底，与 loadFromPath 同规则；只读）
  let project: QijiProject | null = null;
  for (const p of [srcPath, srcPath + ".tmp", srcPath + ".bak"]) {
    try {
      project = JSON.parse(await readTextFile(p)) as QijiProject;
      break;
    } catch {
      project = null;
    }
  }
  if (!project) {
    if (typeof alert !== "undefined") alert(`导入失败：项目文件无法读取或已损坏\n${srcPath}`);
    return false;
  }

  const projName = (project.name || "").trim() || "导入项目";
  const { folderPath, filePath } = await getNewProjectPath(projName);
  const assetsDir = await join(folderPath, "assets");
  await mkdir(assetsDir, { recursive: true });

  // 复制本地素材 + 改写引用：同名只复制一次（文件名=资产 id，全局唯一 §12.2）。
  const refs = collectLocalRefs(project);
  const newPathByName = new Map<string, string | null>(); // 文件名 → 新路径（缺失/失败=null）
  const rewrites = new Map<string, string>();
  let copied = 0;
  let missing = 0;
  for (const ref of refs.values()) {
    const name = fileNameOf(ref.path);
    if (!name) continue;
    if (!newPathByName.has(name)) {
      let np: string | null = null;
      try {
        if (await exists(ref.path)) {
          np = await join(assetsDir, name);
          await copyFile(ref.path, np);
          copied++;
        } else {
          missing++;
        }
      } catch (e) {
        console.warn("[import] 复制素材失败（跳过，凭云端链接自愈）:", ref.path, e);
        np = null;
        missing++;
      }
      newPathByName.set(name, np);
    }
    const np = newPathByName.get(name);
    if (np) rewrites.set(ref.raw, ref.kind === "uri" ? convertFileSrc(np) : np);
  }
  applyRefRewrites(project, rewrites);

  project.name = projName;
  project.savedAt = new Date().toISOString();
  await writeTextFile(filePath, JSON.stringify(project));

  const ok = await useProjectStore.getState().loadFromPath(filePath);
  if (ok && typeof alert !== "undefined") {
    alert(
      `已导入为新项目「${projName}」。\n` +
      `本地素材已复制 ${copied} 个${missing > 0 ? `，${missing} 个本地文件缺失（显示时将按云端链接自动恢复）` : ""}。\n` +
      `原项目文件未做任何修改。`,
    );
  }
  return ok;
}

const RECENT_KEY = "Qiji:recentProjects";
const MAX_RECENT = 10;

export interface RecentProject {
  path: string;
  name: string;
  openedAt: string;
  /** 项目封面缩略图（data URL，已压缩，用于列表卡片展示） */
  cover?: string;
}

/** 五类资产在 store 中的数组字段名（角色/场景/物品/生物/群像） */
export type AssetCat = "characters" | "scenes" | "items" | "organisms" | "crowds";

interface ProjectState {
  name: string;
  savePath: string | null;
  isDirty: boolean;
  recentProjects: RecentProject[];
  isSaving: boolean;
  fileRefs: Record<string, string | null>;
  isProjectLoading: boolean;
  /** 启动时自动恢复了上次项目（运行态信号，非持久化）：Frame21 据此跳转到快照路由 */
  loadedOnStartup: boolean;
  /** 当前加载的项目实例标识（运行态、非持久化）：新建/加载/导入即换新值，供直写型在途任务做归属校验 */
  projectInstanceId: string;
  scriptText: string;
  visualStyle: string;
  /** 新建项目所选画风预设 id（第174轮；决定资产拆分自动附加的【画风前缀】胶囊；空=兜底画风/旧项目） */
  visualStyleId: string;
  /** 项目视觉圣经：全局风格 / 全局色调 / 全局禁用词（资产提取产出，剧本页展示编辑） */
  visualBible: { style: string; colorSystem: string; negativeGlobal: string };
  coverImage: string;
  /* 音色字段五类均可选（第113轮：画布音频可绑到任意资产；资产模式绑音色入口仍仅角色页） */
  characters: Array<{ id: string; name: string; features: string; philosophy: string; prompt: string; image?: string; images?: string[]; variants?: AssetVariantLite[]; voiceUri?: string; voiceAssetId?: string; voiceName?: string }>;
  scenes: Array<{ id: string; name: string; description: string; philosophy: string; prompt: string; image?: string; images?: string[]; variants?: AssetVariantLite[]; voiceUri?: string; voiceAssetId?: string; voiceName?: string }>;
  items: Array<{ id: string; name: string; description: string; philosophy: string; prompt: string; image?: string; images?: string[]; variants?: AssetVariantLite[]; voiceUri?: string; voiceAssetId?: string; voiceName?: string }>;
  organisms: Array<{ id: string; name: string; description: string; philosophy: string; prompt: string; image?: string; images?: string[]; variants?: AssetVariantLite[]; voiceUri?: string; voiceAssetId?: string; voiceName?: string }>;
  // 群像/阵营（G 编号）；与画布节点分组 groups 无关
  crowds: Array<{ id: string; name: string; features: string; philosophy: string; prompt: string; image?: string; images?: string[]; variants?: AssetVariantLite[]; voiceUri?: string; voiceAssetId?: string; voiceName?: string }>;
  isAnalyzed: boolean;
  analysisTime: string;
  /** LibTV 云端画布 UUID（Seedance 2.0 CLI 生成的落点；首次生成时自动创建，随项目持久化） */
  libtvCanvasUuid: string;
  /** 分析进行态（搬进 store：切换界面再切回不丢进度，因底层轮询是单例后台） */
  analysisRunning: boolean;
  analysisProgress: number;
  /** 在途分析任务（持久化到项目文件：关闭客户端后重开仍可凭 taskId 重连服务端取结果） */
  analysisTask: { taskId: string; adapterKey: string; kind: "analyze" | "continue"; startedAt: number } | null;
  episodes: VideoEpisode[];
  /** 多画布：当前激活画布对应的分集 id（null=主画布 __main__）。每个分集是一块独立画布。 */
  canvasEpisodeId: string | null;
  /** 多画布：非激活画布的数据快照（key=分集 id / __main__）。激活画布的实时数据在 canvasStore；
   *  切换/保存时把 canvasStore 快照写回此处对应 key。 */
  canvases: Record<string, CanvasData>;
  projectModelConfig: ProjectModelConfig;
  /** 视频/分镜界面的「视频设置」（逐项目持久化） */
  mediaSettings: MediaSettings;
  /** 界面快照：上次停留的页/集/选中资产/滚动位置（逐项目持久化，重开恢复） */
  uiSnapshot: UiSnapshot;
  pendingGens: PendingGen[];
  /** 在途智能推理任务（断连保护 + 锁定，随项目持久化） */
  inferTasks: InferTask[];
  /** 资产二进制三元映射 assetId → {id,url,localPath,localUri}（随项目持久化） */
  assetBlobs: Record<string, AssetBlob>;
  /** 各生成图的请求详情（出图提示词 + 垫图），按图片 uri 存（供展示区「详情」回看） */
  genMeta: Record<string, GenMeta>;
  /** 记忆的垫图：按 `${cat}:${assetId}:${formKey}` 存（切走再回来仍在） */
  assetRefImages: Record<string, RefImgMemo[]>;
  /** 实时剪辑按分集分档（一个分集 = 一条独立时间轴，key=分集 id；与 canvases 同构）。
   *  ⚠ 单一真相：**激活分集的档位也实时在此**（rtcStore 每次 commit 经 setRtcEpisodeDoc 写回对应
   *  分集档），保存直接持久化整表，无「切换时快照」环节。 */
  rtcDocs: Record<string, RtcDoc>;
  /** 实时剪辑当前激活分集 id（null/失效=第一集，resolveEpisodeKey 同画布规则；窗口本地态不跨窗口同步） */
  rtcEpisodeId: string | null;

  setName: (name: string) => void;
  setSavePath: (path: string) => void;
  markDirty: () => void;
  markClean: () => void;
  addFileRef: (fileId: string, localPath: string | null) => void;
  removeFileRef: (fileId: string) => void;
  setScriptText: (text: string) => void;
  setVisualStyle: (style: string) => void;
  setVisualStyleId: (id: string) => void;
  setLibtvCanvasUuid: (uuid: string) => void;
  setVisualBible: (patch: Partial<{ style: string; colorSystem: string; negativeGlobal: string }>) => void;
  setAnalysisRunning: (running: boolean) => void;
  setAnalysisProgress: (progress: number) => void;
  setAnalysisTask: (task: { taskId: string; adapterKey: string; kind: "analyze" | "continue"; startedAt: number } | null) => void;
  setCoverImage: (cover: string) => void;
  setAnalysisResult: (data: { characters: any[], scenes: any[], items: any[], organisms: any[], crowds?: any[], visualBible?: { style: string; colorSystem: string; negativeGlobal: string }, time: string }) => void;
  updateCharacterImage: (charId: string, imageUri: string) => void;
  updateCrowdImage: (crowdId: string, imageUri: string) => void;
  // 通用资产/变体操作（5 类共用，供资产工作台 AssetWorkbench 使用）
  addAsset: (cat: AssetCat, asset: Record<string, any>) => void;
  removeAsset: (cat: AssetCat, id: string) => void;
  updateAsset: (cat: AssetCat, id: string, patch: Record<string, any>) => void;
  addAssetVariant: (cat: AssetCat, id: string, variant: AssetVariantLite) => void;
  updateAssetVariant: (cat: AssetCat, id: string, variantId: string, patch: Partial<AssetVariantLite>) => void;
  removeAssetVariant: (cat: AssetCat, id: string, variantId: string) => void;
  addAssetImage: (cat: AssetCat, id: string, variantId: string | null, uri: string, makeMain?: boolean) => void;
  setAssetMainImage: (cat: AssetCat, id: string, variantId: string | null, uri: string) => void;
  // 在途生成任务（断连保护）
  addPendingGen: (p: PendingGen) => void;
  updatePendingGen: (id: string, patch: Partial<PendingGen>) => void;
  removePendingGen: (id: string) => void;
  // 在途智能推理任务（锁定 + 断连保护）
  addInferTask: (t: InferTask) => void;
  updateInferTask: (id: string, patch: Partial<InferTask>) => void;
  removeInferTask: (id: string) => void;
  // 资产二进制三元映射
  registerAssetBlob: (blob: AssetBlob) => void;
  blobByUri: (uri: string) => AssetBlob | undefined;
  // 生成图请求详情（详情面板）/ 垫图记忆（切换造型不丢）
  addGenMeta: (uri: string, meta: GenMeta) => void;
  setAssetRefImages: (key: string, refs: RefImgMemo[]) => void;
  /** 实时剪辑文档回写（rtcStore commit/undo/redo 调用；按分集档位写入，分集已删则丢弃）：isDirty + 去抖落盘 */
  setRtcEpisodeDoc: (episodeId: string, doc: RtcDoc) => void;
  /** 切换实时剪辑激活分集（rtcStore 模块订阅据此载入对应分集时间轴） */
  switchRtcEpisode: (episodeId: string) => void;
  setProjectModelConfig: (config: Partial<ProjectModelConfig>) => void;
  setMediaSettings: (patch: Partial<MediaSettings>) => void;
  /** 写入界面快照（按页/集/资产分键深合并，去抖落盘） */
  setUiSnapshot: (patch: Partial<UiSnapshot>) => void;
  // ── 视频/分镜 ──
  setEpisodes: (episodes: VideoEpisode[]) => void;
  addEpisode: (ep?: Partial<VideoEpisode>) => string;
  updateEpisode: (id: string, patch: Partial<VideoEpisode>) => void;
  deleteEpisode: (id: string) => void;
  setEpisodeShots: (episodeId: string, shots: StoryboardShot[]) => void;
  updateShot: (episodeId: string, shotId: string, patch: Partial<StoryboardShot>) => void;
  setCanvasEpisodeId: (id: string | null) => void;
  /** 切换激活画布到某分集（null=主画布）：快照当前画布→canvases，载入目标画布到 canvasStore（独立节点/连线/视口） */
  switchCanvas: (episodeId: string | null) => void;

  save: (isManual?: boolean) => Promise<void>;
  scheduleAutoSave: (tier?: "canvas" | "history" | "viewport") => void;
  saveAs: () => Promise<void>;
  newProject: () => void;
  open: () => Promise<void>;
  loadFromPath: (path: string) => Promise<boolean>;
  /** 项目管理：修改某项目（按文件路径定位）的名称/封面。不需先打开项目——直接改写 .Qiji 文件的
   *  name/coverImage 并同步最近项目列表；若正是当前已打开的项目则改 store 字段后整体保存。
   *  cover：undefined=不改，""=清空，字符串=设为该封面（data URL）。 */
  updateProjectMeta: (path: string, patch: { name?: string; cover?: string }) => Promise<void>;
  exportProject: () => Promise<void>;
  /** 导入 .Qiji 为**新项目**（新建项目文件夹并复制素材，源项目只读不动）；返回是否成功打开新项目 */
  importProject: () => Promise<boolean>;
  ensureProjectPath: () => Promise<string>;
}

function loadRecent(): RecentProject[] {
  try {
    const stored = localStorage.getItem(RECENT_KEY);
    if (stored) return JSON.parse(stored);
  } catch {}
  return [];
}

function saveRecent(projects: RecentProject[]) {
  localStorage.setItem(RECENT_KEY, JSON.stringify(projects));
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  name: "未命名项目",
  savePath: null,
  isDirty: false,
  recentProjects: loadRecent(),
  isSaving: false,
  isProjectLoading: false,
  loadedOnStartup: false,
  projectInstanceId: newInstanceId(),
  fileRefs: {},
  scriptText: "",
  visualStyle: "国漫电影感",
  visualStyleId: "",
  visualBible: { style: "", colorSystem: "", negativeGlobal: "" },
  coverImage: "",
  characters: [],
  scenes: [],
  items: [],
  organisms: [],
  crowds: [],
  isAnalyzed: false,
  analysisTime: "",
  libtvCanvasUuid: "",
  analysisRunning: false,
  analysisProgress: 0,
  analysisTask: null,
  episodes: [],
  canvasEpisodeId: null,
  canvases: {},
  projectModelConfig: {},
  mediaSettings: { ...DEFAULT_MEDIA_SETTINGS },
  uiSnapshot: { ...DEFAULT_UI_SNAPSHOT },
  pendingGens: [],
  inferTasks: [],
  assetBlobs: {},
  genMeta: {},
  assetRefImages: {},
  rtcDocs: {},
  rtcEpisodeId: null,

  setName: (name) => set({ name }),
  setSavePath: (path) => set({ savePath: path }),
  markDirty: () => set({ isDirty: true }),
  markClean: () => set({ isDirty: false }),
  addFileRef: (fileId, localPath) =>
    set((s) => ({ fileRefs: { ...s.fileRefs, [fileId]: localPath } })),
  removeFileRef: (fileId) =>
    set((s) => {
      const next = { ...s.fileRefs };
      delete next[fileId];
      return { fileRefs: next };
    }),
  setScriptText: (scriptText) => { set({ scriptText, isDirty: true }); get().scheduleAutoSave("canvas"); },
  setVisualStyle: (visualStyle) => { set({ visualStyle, isDirty: true }); get().scheduleAutoSave("canvas"); },
  setVisualStyleId: (visualStyleId) => { set({ visualStyleId, isDirty: true }); get().scheduleAutoSave("canvas"); },
  setLibtvCanvasUuid: (libtvCanvasUuid) => { set({ libtvCanvasUuid, isDirty: true }); get().scheduleAutoSave("canvas"); },
  setVisualBible: (patch) => { set((s) => ({ visualBible: { ...s.visualBible, ...patch }, isDirty: true })); get().scheduleAutoSave("canvas"); },
  // 进行态为内存瞬态，不落盘：切换界面再切回靠它复原进度条
  setAnalysisRunning: (analysisRunning) => set({ analysisRunning }),
  setAnalysisProgress: (analysisProgress) => set({ analysisProgress }),
  // 在途分析任务落盘：关客户端后重开可凭它重连服务端
  setAnalysisTask: (analysisTask) => { set({ analysisTask, isDirty: true }); get().scheduleAutoSave("canvas"); },
  setCoverImage: (coverImage) => { set({ coverImage, isDirty: true }); get().scheduleAutoSave("canvas"); },
  setAnalysisResult: (data) => {
    set((s) => ({
      characters: data.characters,
      scenes: data.scenes,
      items: data.items,
      organisms: data.organisms,
      crowds: data.crowds ?? [],
      // visualBible：有非空字段才覆盖，避免空对象抹掉已有
      visualBible: data.visualBible
        ? {
            style: data.visualBible.style || s.visualBible.style,
            colorSystem: data.visualBible.colorSystem || s.visualBible.colorSystem,
            negativeGlobal: data.visualBible.negativeGlobal || s.visualBible.negativeGlobal,
          }
        : s.visualBible,
      isAnalyzed: true,
      analysisTime: data.time,
      isDirty: true,
    }));
    get().scheduleAutoSave("canvas");
  },
  updateCharacterImage: (charId, imageUri) => {
    set((s) => ({
      characters: s.characters.map((c) => c.id === charId ? { ...c, image: imageUri } : c),
      isDirty: true,
    }));
    get().scheduleAutoSave("canvas");
  },
  updateCrowdImage: (crowdId, imageUri) => {
    set((s) => ({
      crowds: s.crowds.map((c) => c.id === crowdId ? { ...c, image: imageUri } : c),
      isDirty: true,
    }));
    get().scheduleAutoSave("canvas");
  },
  addAsset: (cat, asset) => {
    set((s) => ({ [cat]: [...(s[cat] as any[]), asset], isDirty: true } as any));
    get().scheduleAutoSave("canvas");
  },
  removeAsset: (cat, id) => {
    set((s) => ({
      [cat]: (s[cat] as any[]).filter((a) => a.id !== id),
      // 同步清掉该资产残留的在途生成记录（避免删除后孤儿 pending 持续轮询/占位）
      pendingGens: s.pendingGens.filter((p) => !(p.cat === cat && p.assetId === id)),
      isDirty: true,
    } as any));
    get().scheduleAutoSave("canvas");
  },
  updateAsset: (cat, id, patch) => {
    set((s) => ({ [cat]: (s[cat] as any[]).map((a) => a.id === id ? { ...a, ...patch } : a), isDirty: true } as any));
    get().scheduleAutoSave("canvas");
  },
  addAssetVariant: (cat, id, variant) => {
    set((s) => ({ [cat]: (s[cat] as any[]).map((a) => a.id === id ? { ...a, variants: [...(a.variants || []), variant] } : a), isDirty: true } as any));
    get().scheduleAutoSave("canvas");
  },
  updateAssetVariant: (cat, id, variantId, patch) => {
    set((s) => ({ [cat]: (s[cat] as any[]).map((a) => a.id === id ? { ...a, variants: (a.variants || []).map((v: any) => v.id === variantId ? { ...v, ...patch } : v) } : a), isDirty: true } as any));
    get().scheduleAutoSave("canvas");
  },
  removeAssetVariant: (cat, id, variantId) => {
    set((s) => ({
      [cat]: (s[cat] as any[]).map((a) => a.id === id ? { ...a, variants: (a.variants || []).filter((v: any) => v.id !== variantId) } : a),
      // 连带清掉该分体残留的在途生成记录
      pendingGens: s.pendingGens.filter((p) => !(p.cat === cat && p.assetId === id && p.variantId === variantId)),
      isDirty: true,
    } as any));
    get().scheduleAutoSave("canvas");
  },
  addAssetImage: (cat, id, variantId, uri, makeMain = true) => {
    set((s) => ({ [cat]: (s[cat] as any[]).map((a) => {
      if (a.id !== id) return a;
      if (variantId) {
        return { ...a, variants: (a.variants || []).map((v: any) => v.id === variantId ? { ...v, images: [...(v.images || []), uri], image: makeMain ? uri : (v.image || uri) } : v) };
      }
      return { ...a, images: [...(a.images || []), uri], image: makeMain ? uri : (a.image || uri) };
    }), isDirty: true } as any));
    get().scheduleAutoSave("canvas");
  },
  setAssetMainImage: (cat, id, variantId, uri) => {
    set((s) => ({ [cat]: (s[cat] as any[]).map((a) => {
      if (a.id !== id) return a;
      if (variantId) return { ...a, variants: (a.variants || []).map((v: any) => v.id === variantId ? { ...v, image: uri } : v) };
      return { ...a, image: uri };
    }), isDirty: true } as any));
    get().scheduleAutoSave("canvas");
  },
  addPendingGen: (p) => set((s) => ({ pendingGens: [...s.pendingGens, p], isDirty: true })),
  updatePendingGen: (id, patch) => set((s) => ({ pendingGens: s.pendingGens.map((x) => x.id === id ? { ...x, ...patch } : x), isDirty: true })),
  removePendingGen: (id) => set((s) => ({ pendingGens: s.pendingGens.filter((x) => x.id !== id), isDirty: true })),
  addInferTask: (t) => set((s) => ({ inferTasks: [...s.inferTasks, t], isDirty: true })),
  updateInferTask: (id, patch) => set((s) => ({ inferTasks: s.inferTasks.map((x) => x.id === id ? { ...x, ...patch } : x), isDirty: true })),
  removeInferTask: (id) => set((s) => ({ inferTasks: s.inferTasks.filter((x) => x.id !== id), isDirty: true })),
  registerAssetBlob: (blob) => set((s) => ({ assetBlobs: { ...s.assetBlobs, [blob.id]: mergeAssetBlob(s.assetBlobs[blob.id], blob) }, isDirty: true })),
  blobByUri: (uri) => {
    if (!uri) return undefined;
    return Object.values(get().assetBlobs).find((b) => blobMatchesUri(b, uri));
  },
  addGenMeta: (uri, meta) => set((s) => ({ genMeta: { ...s.genMeta, [uri]: meta }, isDirty: true })),
  setAssetRefImages: (key, refs) => {
    set((s) => ({ assetRefImages: { ...s.assetRefImages, [key]: refs }, isDirty: true }));
    get().scheduleAutoSave("canvas");
  },
  setRtcEpisodeDoc: (episodeId, doc) => {
    // 分集已删（stale 回写）→ 丢弃：不给已不存在的分集重建孤儿档位
    if (!get().episodes.some((e) => e.id === episodeId)) return;
    set((s) => ({ rtcDocs: { ...s.rtcDocs, [episodeId]: doc }, isDirty: true }));
    get().scheduleAutoSave("canvas");
  },
  switchRtcEpisode: (episodeId) => {
    const s = get();
    const nextKey = resolveEpisodeKey(episodeId, s.episodes); // 目标无效则回退第一集
    if (s.rtcEpisodeId === nextKey) return;
    set({ rtcEpisodeId: nextKey, isDirty: true }); // rtcEpisodeId 随项目持久化（重开恢复停留分集）
    get().scheduleAutoSave("canvas");
  },
  setProjectModelConfig: (config) => {
    set((s) => ({
      projectModelConfig: { ...s.projectModelConfig, ...config },
      isDirty: true,
    }));
    get().scheduleAutoSave("canvas");
  },
  setMediaSettings: (patch) => {
    set((s) => ({ mediaSettings: { ...s.mediaSettings, ...patch }, isDirty: true }));
    get().scheduleAutoSave("canvas");
  },
  setUiSnapshot: (patch) => {
    set((s) => {
      const cur = s.uiSnapshot || {};
      const next: UiSnapshot = { ...cur };
      if (patch.route !== undefined) next.route = patch.route;
      // assetPages：按资产类型逐键合并（保留其它类型的选中态）
      if (patch.assetPages) {
        const merged = { ...(cur.assetPages || {}) } as NonNullable<UiSnapshot["assetPages"]>;
        for (const k in patch.assetPages) {
          const key = k as keyof NonNullable<UiSnapshot["assetPages"]>;
          merged[key] = { ...(cur.assetPages?.[key] || {}), ...(patch.assetPages[key] || {}) };
        }
        next.assetPages = merged;
      }
      // video：浅合并字段（episodeId/promptTab/滚动位置）
      if (patch.video) next.video = { ...(cur.video || {}), ...patch.video };
      return { uiSnapshot: next, isDirty: true };
    });
    // 仅在项目已落盘时才去抖落盘：避免「未保存项目上的被动滚动/选择」凭空 mkdir 出幽灵项目文件夹。
    // （内存里的快照仍已更新，下次真正保存时会随项目一并写入。）
    // 选择/滚动变更频繁——走最低优先级的 viewport 档去抖（500ms），UI 数据不入 commit hash，不污染历史。
    const s = get();
    if (s.savePath && !s.isProjectLoading) s.scheduleAutoSave("viewport");
  },

  setEpisodes: (episodes) => {
    set({ episodes, isDirty: true });
    get().scheduleAutoSave("canvas");
  },
  addEpisode: (ep) => {
    const id = ep?.id ?? `ep-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    set((s) => {
      const index = ep?.index ?? s.episodes.length + 1;
      const episode: VideoEpisode = {
        id,
        index,
        title: ep?.title ?? `${String(index).padStart(3, "0")}-未命名分集`,
        scriptText: ep?.scriptText ?? "",
        shots: ep?.shots ?? [],
      };
      return { episodes: [...s.episodes, episode], isDirty: true };
    });
    get().scheduleAutoSave("canvas");
    return id;
  },
  updateEpisode: (id, patch) => {
    set((s) => ({
      episodes: s.episodes.map((e) => (e.id === id ? { ...e, ...patch } : e)),
      isDirty: true,
    }));
    get().scheduleAutoSave("canvas");
  },
  deleteEpisode: (id) => {
    const s0 = get();
    if (s0.episodes.length <= 1) return; // 至少保留一集，不能删到 0
    // 多画布：若正看其画布 → 先切到另一集（删前切，避免停留在将被删的画布），再丢弃该集画布数据
    // ⚠ 判定用 resolveCanvasKey 而非裸比 canvasEpisodeId：canvasEpisodeId 为 null 时实际激活的是第一集，
    // 裸比会漏切——删第一集后活动画布内容仍是被删集，下次快照会把它错写进新的第一集画布。
    if (resolveCanvasKey(s0.canvasEpisodeId, s0.episodes) === id) {
      const next = s0.episodes.find((e) => e.id !== id);
      if (next) get().switchCanvas(next.id);
    }
    set((s) => {
      const canvases = { ...s.canvases };
      delete canvases[id];
      // 实时剪辑：该集时间轴一并丢弃；正在编辑该集则切到余下的第一集（rtcStore 订阅自动载入）
      const rtcDocs = { ...s.rtcDocs };
      delete rtcDocs[id];
      const rtcEpisodeId = resolveEpisodeKey(s.rtcEpisodeId, s.episodes) === id
        ? (s.episodes.find((e) => e.id !== id)?.id ?? null)
        : s.rtcEpisodeId;
      return { episodes: s.episodes.filter((e) => e.id !== id), canvases, rtcDocs, rtcEpisodeId, isDirty: true };
    });
    get().scheduleAutoSave("canvas");
  },
  setEpisodeShots: (episodeId, shots) => {
    set((s) => ({
      episodes: s.episodes.map((e) => (e.id === episodeId ? { ...e, shots } : e)),
      isDirty: true,
    }));
    get().scheduleAutoSave("canvas");
  },
  updateShot: (episodeId, shotId, patch) => {
    set((s) => ({
      episodes: s.episodes.map((e) =>
        e.id === episodeId
          ? { ...e, shots: e.shots.map((sh) => (sh.id === shotId ? { ...sh, ...patch } : sh)) }
          : e,
      ),
      isDirty: true,
    }));
    get().scheduleAutoSave("canvas");
  },
  setCanvasEpisodeId: (canvasEpisodeId) => set({ canvasEpisodeId }),
  switchCanvas: (episodeId) => {
    const s = get();
    const curKey = resolveCanvasKey(s.canvasEpisodeId, s.episodes);
    const nextKey = resolveCanvasKey(episodeId, s.episodes); // 目标无效则回退第一集
    if (curKey === nextKey) { set({ canvasEpisodeId: nextKey }); return; }
    // 1. 快照当前活动画布存回 canvases[curKey]
    const canvases = { ...s.canvases, [curKey]: snapshotActiveCanvas() };
    // 2. 载入目标画布到 canvasStore（空则空画布），清洗未知节点，重置撤销栈
    const target = canvases[nextKey];
    const cleaned = target ? sanitizeCanvas(target.nodes || {}, target.edges || {}, target.groups || {}) : { nodes: {}, edges: {}, groups: {} };
    useCanvasStore.setState({
      nodes: cleaned.nodes, edges: cleaned.edges, groups: cleaned.groups,
      viewport: target?.viewport ?? { x: 0, y: 0, zoom: 0.7 },
      runtime: {}, past: [], future: [],
    });
    set({ canvases, canvasEpisodeId: nextKey, isDirty: true });
    // 断连保护：新激活画布上的在途任务（node.data.task）重挂轮询接回结果（已在跟踪中的自动跳过）
    void import("@/nodes/pluginRegistry").then((m) => m.resumeCanvasNodeTasks()).catch(() => {});
    // 请求台账（第204轮）：画布环境变化 → 重新认领轮询 + 尝试投递缓存结果
    void import("@/store/requestLedgerStore").then((m) => m.onProjectContextChanged()).catch(() => {});
    if (s.savePath) get().scheduleAutoSave("canvas");
  },

  save: async (isManual = false) => {
    const s = get();
    if (s.isSaving) return;
    // 弹出窗口（助手独立窗口）为只读视图：不写项目文件，避免与主窗口互相覆盖。
    if (typeof window !== "undefined" && (window as unknown as { __QIJI_POPOUT__?: string }).__QIJI_POPOUT__) return;
    // 多窗口协同（第205轮）：**非写者窗口不写盘**——同项目开多个窗口时只有写者（最先开的窗口）
    // 落盘；状态已实时镜像到写者，双写=整文件互相覆盖（改造前多开丢数据的根源，勿回退）。
    // 手动保存转发给写者执行；单窗口/项目未落盘时 isProjectWriter 恒 true，行为与从前一致。
    if (s.savePath && !isProjectWriter()) {
      if (isManual) void import("@/services/projectSync").then((m) => m.requestWriterSave()).catch(() => {});
      set({ isDirty: false }); // 镜像已在写者手里，本窗口视为不脏（写者会替全体落盘）
      return;
    }
    // 自动保存（isManual=false）绝不新建项目：无 savePath（未打开/未保存项目）时直接跳过，
    // 避免后台去抖保存在「无项目」状态下凭空生成「未命名项目」幽灵文件夹。
    // 新项目的首次落盘一律走显式 save(true)（新建向导 / 手动保存）或 ensureProjectPath（出图/分析等）。
    if (!isManual && !s.savePath) return;
    set({ isSaving: true });
    try {
      const canvas = useCanvasStore.getState();
      // 多画布：把当前活动画布快照写回 canvases[activeKey]，连同其它画布一起持久化
      const activeCanvasKey = resolveCanvasKey(s.canvasEpisodeId, s.episodes);
      const canvases: Record<string, CanvasData> = { ...s.canvases, [activeCanvasKey]: { nodes: canvas.nodes, edges: canvas.edges, groups: canvas.groups, viewport: canvas.viewport } };
      const message = isManual ? "手动保存" : "自动保存";
      const targetCommitId = await useCommitStore.getState().createCommit(message);
      const commits = useCommitStore.getState().commits;

      if (isTauri()) {
        const { writeTextFile, exists, mkdir, rename, remove } = await import("@tauri-apps/plugin-fs");
        const { join } = await import("@tauri-apps/api/path");

        let savePath = s.savePath;
        if (!savePath) {
          const { folderPath, filePath } = await getNewProjectPath(s.name);
          if (!(await exists(folderPath))) {
            await mkdir(folderPath, { recursive: true });
          }
          savePath = filePath;
          set({ savePath });
        }

        const folder = savePath.replace(/[/\\][^/\\]+$/, "");
        const assetsDir = await join(folder, "assets");
        if (!(await exists(assetsDir))) {
          await mkdir(assetsDir, { recursive: true });
        }

        const projectData: QijiProject = {
          version: "2.0",
          savedAt: new Date().toISOString(),
          name: s.name,
          nodes: canvas.nodes,
          edges: canvas.edges,
          groups: canvas.groups,
          viewport: canvas.viewport,
          canvases,
          activeCanvasKey,
          files: s.fileRefs,
          commits,
          head: targetCommitId,
          scriptText: s.scriptText,
          visualStyle: s.visualStyle,
          visualStyleId: s.visualStyleId || undefined,
          visualBible: s.visualBible,
          coverImage: s.coverImage,
          characters: s.characters,
          scenes: s.scenes,
          items: s.items,
          organisms: s.organisms,
          crowds: s.crowds,
          isAnalyzed: s.isAnalyzed,
          analysisTime: s.analysisTime,
          libtvCanvasUuid: s.libtvCanvasUuid || undefined,
          episodes: s.episodes,
          pendingGens: s.pendingGens,
          inferTasks: s.inferTasks,
          analysisTask: s.analysisTask,
          assetBlobs: s.assetBlobs,
          projectModelConfig: s.projectModelConfig,
          mediaSettings: s.mediaSettings,
          uiSnapshot: s.uiSnapshot,
          genMeta: s.genMeta,
          assetRefImages: s.assetRefImages,
          rtcDocs: Object.keys(s.rtcDocs).length ? s.rtcDocs : undefined,
          rtcEpisodeId: s.rtcEpisodeId || undefined,
        };

        await normalizeProjectAssets(projectData, assetsDir);
        // 剥离 genMeta/assetRefImages 里的 data:/blob: 重字节（垫图整段 base64 → 公网 url 或丢弃）：
        // 只作用于持久化副本，防 project.Qiji 膨胀到上百 MB（§7.1）。当前会话 store 保留原始 uri 不受影响。
        {
          const slim = stripHeavyRefs(projectData.genMeta, projectData.assetRefImages, projectData.assetBlobs);
          projectData.genMeta = slim.genMeta;
          projectData.assetRefImages = slim.assetRefImages;
        }
        // 原子保存：先写 .tmp，再把现有完整文件轮换成 .bak 备份，最后改名生效。
        // 任何时刻磁盘上都至少有一份完整可解析的项目文件——程序异常中断（崩溃/强杀/断电）
        // 不再会把 project.Qiji 写成半截 JSON 导致项目永久打不开。
        // 紧凑序列化（无缩进）：pretty-print 让 stringify 更慢、文件大 ~40%，自动保存高频跑，
        // 这是主线程卡顿的直接成本（JSON.parse 两种格式都吃，无兼容问题）。
        const json = JSON.stringify(projectData);
        const tmpPath = savePath + ".tmp";
        const bakPath = savePath + ".bak";
        await writeTextFile(tmpPath, json);
        await fsyncQuiet(tmpPath); // rename 生效前先把 .tmp 数据刷盘，防断电双清零
        try {
          if (await exists(savePath)) {
            if (await exists(bakPath)) await remove(bakPath);
            await rename(savePath, bakPath);
          }
        } catch (e) {
          console.warn("[project] rotate backup failed (non-fatal):", e);
        }
        try {
          await rename(tmpPath, savePath);
        } catch {
          // 轮换失败导致目标仍存在（Windows rename 不覆盖）→ 退回直写，并清掉临时文件
          await writeTextFile(savePath, json);
          try { await remove(tmpPath); } catch {}
        }

        // WebDAV 云端同步（异步，不阻塞本地保存）
        maybeSyncToWebdav(projectData);

        // 引用上报（P1，节流 10 分钟）：自动保存很频繁，而保留策略按天算，报太密纯浪费
        void import("@/services/assetRefReport").then((m) => m.reportProjectAssetRefs()).catch(() => {});

        const recent = get().recentProjects;
        const existing = recent.findIndex((p) => p.path === savePath);
        const entry = { path: savePath, name: s.name, openedAt: new Date().toISOString(), cover: s.coverImage || undefined };
        const updated = existing >= 0
          ? [entry, ...recent.filter((_, i) => i !== existing)]
          : [entry, ...recent];
        saveRecent(updated.slice(0, MAX_RECENT));
        set({ recentProjects: updated.slice(0, MAX_RECENT), isDirty: false });
        notifySaved();
        useSettingsStore.getState().setLastOpenedProjectPath(savePath);
      } else {
        const projectData: QijiProject = {
          version: "2.0",
          savedAt: new Date().toISOString(),
          name: s.name,
          nodes: canvas.nodes,
          edges: canvas.edges,
          groups: canvas.groups,
          viewport: canvas.viewport,
          canvases,
          activeCanvasKey,
          files: s.fileRefs,
          commits,
          head: targetCommitId,
          scriptText: s.scriptText,
          visualStyle: s.visualStyle,
          visualStyleId: s.visualStyleId || undefined,
          visualBible: s.visualBible,
          coverImage: s.coverImage,
          characters: s.characters,
          scenes: s.scenes,
          items: s.items,
          organisms: s.organisms,
          crowds: s.crowds,
          isAnalyzed: s.isAnalyzed,
          analysisTime: s.analysisTime,
          libtvCanvasUuid: s.libtvCanvasUuid || undefined,
          episodes: s.episodes,
          pendingGens: s.pendingGens,
          inferTasks: s.inferTasks,
          analysisTask: s.analysisTask,
          assetBlobs: s.assetBlobs,
          projectModelConfig: s.projectModelConfig,
          mediaSettings: s.mediaSettings,
          uiSnapshot: s.uiSnapshot,
          genMeta: s.genMeta,
          assetRefImages: s.assetRefImages,
          rtcDocs: Object.keys(s.rtcDocs).length ? s.rtcDocs : undefined,
          rtcEpisodeId: s.rtcEpisodeId || undefined,
        };
        {
          const slim = stripHeavyRefs(projectData.genMeta, projectData.assetRefImages, projectData.assetBlobs);
          projectData.genMeta = slim.genMeta;
          projectData.assetRefImages = slim.assetRefImages;
        }
        const blob = new Blob([JSON.stringify(projectData, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${s.name.replace(/[\\/:*?"<>|]/g, "_")}.Qiji`;
        a.click();
        URL.revokeObjectURL(url);
        set({ isDirty: false });
        notifySaved();
      }
    } catch (err) {
      console.error("Failed to save project:", err);
    } finally {
      set({ isSaving: false });
    }
  },

  saveAs: async () => {
    if (isTauri()) {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const path = await save({
        filters: [{ name: "Qiji Project", extensions: ["Qiji"] }],
      });
      if (path) {
        set({ savePath: path as string });
        await get().save(true);
      }
    } else {
      await get().save(true);
    }
  },

  newProject: () => {
    const firstEp = makeFirstEpisode(); // 至少一集，默认第一集
    set({
      name: "未命名项目",
      savePath: null,
      isDirty: false,
      projectInstanceId: newInstanceId(),
      fileRefs: {},
      scriptText: "",
      visualStyle: "国漫电影感",
      visualStyleId: "",
      visualBible: { style: "", colorSystem: "", negativeGlobal: "" },
      coverImage: "",
      characters: [],
      scenes: [],
      items: [],
      organisms: [],
      crowds: [],
      isAnalyzed: false,
      analysisTime: "",
      libtvCanvasUuid: "",
      analysisRunning: false,
      analysisProgress: 0,
      analysisTask: null,
      episodes: [firstEp],
      canvasEpisodeId: firstEp.id,
      canvases: {},
      projectModelConfig: {},
      mediaSettings: { ...DEFAULT_MEDIA_SETTINGS },
      uiSnapshot: { ...DEFAULT_UI_SNAPSHOT },
      pendingGens: [],
      inferTasks: [],
      genMeta: {},
      assetRefImages: {},
      rtcDocs: {},
      rtcEpisodeId: firstEp.id,
    });
    useCommitStore.setState({ head: "commit-init", commits: createInitialCommits() });
    useCanvasStore.setState({
      nodes: {},
      edges: {},
      groups: {},
      viewport: { x: 0, y: 0, zoom: 0.7 },
      runtime: {}, past: [], future: [],
    });
    useLibraryStore.setState({ assets: {} });
  },

  open: async () => {
    if (isTauri()) {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const path = await open({
        filters: [{ name: "Qiji Project", extensions: ["Qiji"] }],
      });
      if (path) {
        await get().loadFromPath(path as string);
      }
    }
  },

  updateProjectMeta: async (path, patch) => {
    const name = patch.name?.trim();
    const cover = patch.cover; // undefined=不改，""=清空，string=设值

    // 当前打开的就是这个项目：改 store 字段后整体保存（save 会写文件并刷新最近项目列表）
    if (get().savePath === path) {
      if (name) set({ name });
      if (cover !== undefined) set({ coverImage: cover });
      await get().save(true);
      return;
    }

    // 未打开的项目：直接改写 .Qiji 文件（读取带 .tmp/.bak 兜底 + 原子写回，与 save 同规则）
    if (isTauri()) {
      const { readTextFile, writeTextFile, exists, rename, remove } = await import("@tauri-apps/plugin-fs");
      let raw: string | null = null;
      for (const p of [path, path + ".tmp", path + ".bak"]) {
        try { raw = await readTextFile(p); break; } catch {}
      }
      if (raw == null) throw new Error("项目文件读取失败，可能已被移动或删除");
      const proj = JSON.parse(raw) as QijiProject;
      if (name) proj.name = name;
      if (cover !== undefined) proj.coverImage = cover;
      proj.savedAt = new Date().toISOString();
      {
        // 顺带给存量项目瘦身（剥 data:/blob: 重字节，§7.1）
        const slim = stripHeavyRefs(proj.genMeta, proj.assetRefImages, proj.assetBlobs);
        proj.genMeta = slim.genMeta;
        proj.assetRefImages = slim.assetRefImages;
      }
      const json = JSON.stringify(proj);
      const tmpPath = path + ".tmp";
      const bakPath = path + ".bak";
      await writeTextFile(tmpPath, json);
      await fsyncQuiet(tmpPath); // rename 生效前先把 .tmp 数据刷盘，防断电双清零
      try {
        if (await exists(path)) {
          if (await exists(bakPath)) await remove(bakPath);
          await rename(path, bakPath);
        }
      } catch (e) {
        console.warn("[project] rotate backup failed (non-fatal):", e);
      }
      try {
        await rename(tmpPath, path);
      } catch {
        await writeTextFile(path, json);
        try { await remove(tmpPath); } catch {}
      }
    }

    // 同步最近项目列表（Tauri 已改文件；非 Tauri 亦保证列表即时更新）
    const recent = get().recentProjects.map((p) =>
      p.path === path
        ? { ...p, name: name || p.name, cover: cover === undefined ? p.cover : cover || undefined }
        : p,
    );
    saveRecent(recent);
    set({ recentProjects: recent });
  },

  loadFromPath: async (path: string): Promise<boolean> => {
    set({ isProjectLoading: true });
    let recoveredFrom: ".tmp" | ".bak" | null = null;
    try {
      const { readTextFile } = await import("@tauri-apps/plugin-fs");
      let project: QijiProject;
      try {
        project = JSON.parse(await readTextFile(path));
      } catch (parseErr) {
        // 主文件损坏/缺失（多因保存写盘途中程序异常中断被截断）→
        // 依次尝试 .tmp（已完整写出但未改名生效的新版本）与 .bak（上一次完整保存的备份）
        let recovered: QijiProject | null = null;
        for (const suffix of [".tmp", ".bak"] as const) {
          try {
            recovered = JSON.parse(await readTextFile(path + suffix));
            recoveredFrom = suffix;
            break;
          } catch {}
        }
        if (!recovered) {
          console.error("Failed to load project (file corrupted, no backup):", parseErr);
          if (typeof alert !== "undefined") {
            alert(
              `项目文件已损坏，无法打开：\n${path}\n\n` +
              `多为上次保存写盘途中程序异常退出导致（文件被截断）。\n` +
              `请不要删除该项目文件夹（含 assets 资产原件），可联系开发者尝试修复。`
            );
          }
          return false;
        }
        console.warn(`[project] 主文件损坏，已从 ${recoveredFrom} 恢复:`, parseErr);
        project = recovered;
      }

      const headId = project.head || "commit-init";
      const headCommit = project.commits?.[headId];

      const nodes = project.nodes && Object.keys(project.nodes).length > 0
        ? project.nodes
        : headCommit?.canvas?.nodes || {};
      const edges = project.edges && Object.keys(project.edges).length > 0
        ? project.edges
        : headCommit?.canvas?.edges || {};
      const groups = project.groups && Object.keys(project.groups).length > 0
        ? project.groups
        : headCommit?.canvas?.groups || {};
      const viewport = project.viewport || headCommit?.canvas?.viewport || { x: 0, y: 0, zoom: 0.7 };

      // 至少一集：空项目/旧无分集项目自动补「第一集」
      const loadEpisodes = ensureEpisodes(project.episodes);
      // 多画布载入：每集一块画布。优先 project.canvases；旧项目（无 canvases）把顶层/commit 画布迁移到第一集。
      const canvasesMap: Record<string, CanvasData> = (project.canvases && Object.keys(project.canvases).length > 0)
        ? { ...project.canvases }
        : { [loadEpisodes[0].id]: { nodes, edges, groups, viewport } };
      // 激活画布 = 有效分集（activeCanvasKey 若指向存在的分集则用之，否则第一集）
      const activeKey = resolveCanvasKey(project.activeCanvasKey ?? null, loadEpisodes);
      const activeCanvas = canvasesMap[activeKey] || { nodes: {}, edges: {}, groups: {}, viewport };
      const loadCanvasEpisodeId = activeKey;

      set({
        name: project.name || "未命名项目",
        savePath: path,
        projectInstanceId: newInstanceId(),
        fileRefs: project.files || {},
        isDirty: false,
        scriptText: project.scriptText || "",
        visualStyle: project.visualStyle || "国漫电影感",
        visualStyleId: project.visualStyleId || "",
        visualBible: project.visualBible || { style: "", colorSystem: "", negativeGlobal: "" },
        coverImage: project.coverImage || "",
        characters: project.characters || [],
        scenes: project.scenes || [],
        items: project.items || [],
        organisms: project.organisms || [],
        crowds: (project as any).crowds || [],
        isAnalyzed: project.isAnalyzed || false,
        analysisTime: project.analysisTime || "",
        libtvCanvasUuid: project.libtvCanvasUuid || "",
        analysisRunning: false,
        analysisProgress: 0,
        episodes: loadEpisodes,
        canvasEpisodeId: loadCanvasEpisodeId,
        canvases: canvasesMap,
        projectModelConfig: project.projectModelConfig || {},
        mediaSettings: { ...DEFAULT_MEDIA_SETTINGS, ...(project.mediaSettings || {}) },
        uiSnapshot: { ...DEFAULT_UI_SNAPSHOT, ...(project.uiSnapshot || {}) },
        pendingGens: (project as any).pendingGens || [],
        inferTasks: (project as any).inferTasks || [],
        analysisTask: (project as any).analysisTask || null,
        // 三元映射清洗（第145轮）：剥除上一会话持久化下来的 blob: localUri（objectURL 跨会话必死，
        // 留着会让 显示解析/上传去重 拿到死链——「本地素材经常丢失」根因之一）
        assetBlobs: sanitizeAssetBlobs((project as any).assetBlobs || {}),
        genMeta: (project as any).genMeta || {},
        assetRefImages: (project as any).assetRefImages || {},
        rtcDocs: migrateRtcDocs(project, loadEpisodes),
        rtcEpisodeId: project.rtcEpisodeId ?? null, // 失效/缺省经 resolveEpisodeKey 回退第一集
      });

      useCommitStore.setState({
        head: headId,
        commits: project.commits || {},
      });

      // 旧画布重做：丢弃无法识别的旧节点类型（级联清边/分组）。多画布下载入「激活画布」到 canvasStore。
      const cleaned = sanitizeCanvas(activeCanvas.nodes || {}, activeCanvas.edges || {}, activeCanvas.groups || {});
      useCanvasStore.setState({ nodes: cleaned.nodes, edges: cleaned.edges, groups: cleaned.groups, viewport: activeCanvas.viewport || viewport, runtime: {}, past: [], future: [] });

      if (headCommit?.assets && Object.keys(headCommit.assets).length > 0) {
        useLibraryStore.setState({ assets: headCommit.assets });
      } else if ((project as any).assets) {
        useLibraryStore.setState({ assets: (project as any).assets });
      }
      // 素材库显示自愈（第145轮）：死 blob:/远程 CSP 裂图的记录按 localPath/映射/公网 url 重解显示 uri
      // （fire-and-forget；动态 import 防 projectStore ↔ libraryHeal 循环依赖）
      void import("@/services/libraryHeal").then((m) => m.healLibraryAssets()).catch(() => {});

      // 引用上报（P1）：告诉服务端这个项目还在用哪些资产 → 刷 last_ref_at，保留更久。
      // 打开项目是最完整的一次引用声明，强制上报（跳过节流）。fire-and-forget 不阻塞加载。
      void import("@/services/assetRefReport").then((m) => { m.resetAssetRefThrottle(); return m.reportProjectAssetRefs(true); }).catch(() => {});

      useSettingsStore.getState().setLastOpenedProjectPath(path);

      const recent = get().recentProjects;
      const existing = recent.findIndex((p) => p.path === path);
      const entry = { path, name: project.name || "未命名项目", openedAt: new Date().toISOString(), cover: project.coverImage || undefined };
      const updated = existing >= 0
        ? [entry, ...recent.filter((_, i) => i !== existing)]
        : [entry, ...recent];
      saveRecent(updated.slice(0, MAX_RECENT));
      set({ recentProjects: updated.slice(0, MAX_RECENT) });

      // 断连保护：项目加载后续跑上次未完成的在途生成（重新挂轮询 / 标失败可重试）。
      // 动态 import 规避 projectStore ↔ generationQueue 的循环引用。
      try {
        const { resumePendingGenerations } = await import("@/services/generationQueue");
        resumePendingGenerations();
        const { resumeInferTasks } = await import("@/services/inferRun");
        resumeInferTasks();
        // 画布节点在途任务（node.data.task）：凭 taskId+adapterKey 重挂轮询接回结果（不重提交不扣费）
        const { resumeCanvasNodeTasks } = await import("@/nodes/pluginRegistry");
        resumeCanvasNodeTasks();
        // 请求台账（第204轮）：项目环境就绪 → 认领「画布流程够不着」的在途任务（非激活画布/他项目）
        // + 把台账里缓存的完成结果按身份投递（节点已删则转找回通知）
        const { onProjectContextChanged } = await import("@/store/requestLedgerStore");
        onProjectContextChanged();
      } catch (e) {
        console.warn("[project] resume pending generations skipped:", e);
      }

      // 从备份恢复成功：立即把完整内容原子写回主文件（下次直接可开），并告知用户
      if (recoveredFrom) {
        try { await get().save(true); } catch (e) { console.warn("[project] rewrite after recovery failed:", e); }
        if (typeof alert !== "undefined") {
          alert(
            `检测到项目文件损坏（上次保存时程序异常中断），` +
            `已自动从${recoveredFrom === ".bak" ? "备份（上一次完整保存）" : "未生效的新版本"}恢复。\n` +
            `最后一次改动可能丢失，请检查项目内容。`
          );
        }
      }

      return true;
    } catch (err) {
      console.error("Failed to load project:", err);
      if (typeof alert !== "undefined") {
        alert(`打开项目失败：\n${path}\n\n${String(err)}`);
      }
      return false;
    } finally {
      set({ isProjectLoading: false });
    }
  },

  exportProject: async () => {
    const canvas = useCanvasStore.getState();
    const s = get();
    const { head, commits } = useCommitStore.getState();

    // 与 save 完全一致的**完整**项目数据（此前 export 漏了 canvases/coverImage/crowds/episodes/
    // mediaSettings/uiSnapshot/genMeta/assetRefImages 等——导入后画布/封面/资产图全丢）。
    const activeCanvasKey = resolveCanvasKey(s.canvasEpisodeId, s.episodes);
    const canvases: Record<string, CanvasData> = { ...s.canvases, [activeCanvasKey]: snapshotActiveCanvas() };
    const full: QijiProject = {
      version: "2.0",
      savedAt: new Date().toISOString(),
      name: s.name,
      nodes: canvas.nodes,
      edges: canvas.edges,
      groups: canvas.groups,
      viewport: canvas.viewport,
      canvases,
      activeCanvasKey,
      files: s.fileRefs,
      commits,
      head,
      scriptText: s.scriptText,
      visualStyle: s.visualStyle,
      visualStyleId: s.visualStyleId || undefined,
      visualBible: s.visualBible,
      coverImage: s.coverImage,
      characters: s.characters,
      scenes: s.scenes,
      items: s.items,
      organisms: s.organisms,
      crowds: s.crowds,
      isAnalyzed: s.isAnalyzed,
      analysisTime: s.analysisTime,
      libtvCanvasUuid: s.libtvCanvasUuid || undefined,
      episodes: s.episodes,
      pendingGens: s.pendingGens,
      inferTasks: s.inferTasks,
      analysisTask: s.analysisTask,
      assetBlobs: s.assetBlobs,
      projectModelConfig: s.projectModelConfig,
      mediaSettings: s.mediaSettings,
      uiSnapshot: s.uiSnapshot,
      genMeta: s.genMeta,
      assetRefImages: s.assetRefImages,
    };

    // 跨设备化：本地资产引用 → 公网 url，剥掉本地路径（详见 toPortableProjectData）
    const { data: projectData, unresolved } = toPortableProjectData(full);

    const blob = new Blob([JSON.stringify(projectData)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${s.name.replace(/[\\/:*?"<>|]/g, "_")}_export.Qiji`;
    a.click();
    URL.revokeObjectURL(url);

    if (unresolved > 0 && typeof alert !== "undefined") {
      alert(
        `导出完成。\n\n注意：约 ${unresolved} 处资产只有本机文件、没有云端地址，换设备打开时可能无法显示。\n` +
        `建议先在「设置」里配置 OSS 对象存储，重新生成/上传这些资产后再导出，即可完整跨设备使用。`,
      );
    }
  },

  importProject: async (): Promise<boolean> => {
    // 导入语义（第173轮用户定，勿回退）：导入 = 新建项目并复制文件——选中 .Qiji 后立即新建
    // 项目文件夹、复制引用到的本地素材、改写引用后落盘并打开；源文件/源项目只读分毫不动。
    if (isTauri()) {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({
        filters: [{ name: "Qiji Project", extensions: ["Qiji", "json"] }],
        multiple: false,
      });
      if (!picked || typeof picked !== "string") return false;
      return importAsNewProject(picked);
    }
    // 浏览器（dev）无文件系统：保持旧的内存导入（savePath=null，保存时另存），不影响源文件
    return new Promise<boolean>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".Qiji,.json";
    // 现代浏览器取消选择会触发 cancel（老浏览器不触发=悬空，仅 dev 路径可接受）
    input.oncancel = () => resolve(false);
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) { resolve(false); return; }
      const reader = new FileReader();
      reader.onerror = () => resolve(false);
      reader.onload = async (e) => {
        try {
          const project: QijiProject = JSON.parse(e.target?.result as string);
          const impEpisodes = ensureEpisodes(project.episodes); // 至少一集
          const impCanvases: Record<string, CanvasData> = (project.canvases && Object.keys(project.canvases).length > 0)
            ? { ...project.canvases }
            : { [impEpisodes[0].id]: { nodes: (project as any).nodes || {}, edges: (project as any).edges || {}, groups: (project as any).groups || {}, viewport: (project as any).viewport } };
          const impActiveKey = resolveCanvasKey(project.activeCanvasKey ?? null, impEpisodes);
          set({
            name: project.name || "导入项目",
            savePath: null,
            projectInstanceId: newInstanceId(),
            fileRefs: project.files || {},
            isDirty: true,
            scriptText: project.scriptText || "",
            visualStyle: project.visualStyle || "国漫电影感",
            visualStyleId: project.visualStyleId || "",
            visualBible: project.visualBible || { style: "", colorSystem: "", negativeGlobal: "" },
            coverImage: project.coverImage || "",
            characters: project.characters || [],
            scenes: project.scenes || [],
            items: project.items || [],
            organisms: project.organisms || [],
            crowds: (project as any).crowds || [],
            isAnalyzed: project.isAnalyzed || false,
            analysisTime: project.analysisTime || "",
            libtvCanvasUuid: project.libtvCanvasUuid || "",
            analysisRunning: false,
            analysisProgress: 0,
            episodes: impEpisodes,
            canvasEpisodeId: impActiveKey,
            canvases: impCanvases,
            projectModelConfig: project.projectModelConfig || {},
            mediaSettings: { ...DEFAULT_MEDIA_SETTINGS, ...((project as any).mediaSettings || {}) },
            uiSnapshot: { ...DEFAULT_UI_SNAPSHOT, ...((project as any).uiSnapshot || {}) },
            pendingGens: (project as any).pendingGens || [],
            inferTasks: (project as any).inferTasks || [],
            analysisTask: (project as any).analysisTask || null,
            assetBlobs: (project as any).assetBlobs || {},
            genMeta: (project as any).genMeta || {},
            assetRefImages: (project as any).assetRefImages || {},
            rtcDocs: migrateRtcDocs(project, impEpisodes),
            rtcEpisodeId: project.rtcEpisodeId ?? null,
          });
          useCommitStore.setState({
            head: project.head || "commit-init",
            commits: project.commits || {},
          });
          {
            // 多画布：导入后激活第一集/activeCanvasKey 对应的画布
            const active = impCanvases[impActiveKey];
            const imp = sanitizeCanvas(active?.nodes || {}, active?.edges || {}, active?.groups || {});
            useCanvasStore.setState({
              nodes: imp.nodes,
              edges: imp.edges,
              groups: imp.groups,
              viewport: active?.viewport || { x: 0, y: 0, zoom: 0.7 },
              runtime: {}, past: [], future: [],
            });
          }
          if ((project as any).assets) {
            useLibraryStore.setState({ assets: (project as any).assets });
          }
          // 导入路径同样自愈素材库显示 uri（浏览器侧：死 blob: 换公网 url）
          void import("@/services/libraryHeal").then((m) => m.healLibraryAssets()).catch(() => {});
          resolve(true);
        } catch (err) {
          console.error("Failed to import project:", err);
          resolve(false);
        }
      };
      reader.readAsText(file);
    };
    input.click();
    });
  },

  ensureProjectPath: async (): Promise<string> => {
    if (!isTauri()) return "browser";
    const s = get();
    if (s.savePath) return s.savePath;
    const { folderPath, filePath } = await getNewProjectPath(s.name);
    const { exists, mkdir } = await import("@tauri-apps/plugin-fs");
    if (!(await exists(folderPath))) {
      await mkdir(folderPath, { recursive: true });
    }
    set({ savePath: filePath });
    return filePath;
  },

  scheduleAutoSave: (tier = "canvas") => {
    scheduleSave(tier);
  },
}));

// 初始化三档去抖：绑定 save / markDirty
initDebouncedSave(
  () => useProjectStore.getState().save(),
  () => useProjectStore.getState().markDirty(),
);

// ─── WebDAV 云端同步（fire-and-forget，不阻塞本地保存） ───

let _lastSyncTimer: ReturnType<typeof setTimeout> | null = null;

function maybeSyncToWebdav(projectData: QijiProject) {
  const settings = useSettingsStore.getState();
  if (!settings.enableCloudSync || !settings.webdavUrl.trim()) return;

  // 去抖 2s：短时间内多次保存只触发最后一次同步
  if (_lastSyncTimer) clearTimeout(_lastSyncTimer);
  _lastSyncTimer = setTimeout(async () => {
    try {
      const { uploadProjectFile } = await import("@/services/webdavSync");
      const config = {
        url: settings.webdavUrl,
        directory: settings.webdavDirectory,
        username: settings.webdavUsername,
        password: settings.webdavPassword,
      };
      const projectName = (projectData.name || "untitled").replace(/[\\/:*?"<>|]/g, "_");
      const projectFileName = `${projectName}.Qiji`;
      await uploadProjectFile(config, projectFileName, JSON.stringify(projectData));
      console.log(`[WebDAV] 项目 "${projectName}" 已同步`);
    } catch (err) {
      console.error("[WebDAV] 同步失败:", err);
    }
  }, 2000);
}