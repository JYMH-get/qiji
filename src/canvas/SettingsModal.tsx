import { useState, useEffect } from "react";
import { useSettingsStore } from "@/store/settingsStore";
import { useConnectionStore } from "@/store/connectionStore";
import { useCatalogStore } from "@/store/catalogStore";
import { useUiStore } from "@/store/uiStore";
import {
  getChannelModelsForNodeType,
  getModelsForCapability,
  type ModelOption,
} from "@/services/adapters/channelAdapter";
import type { Capability } from "@/contract";
import {
  X, FolderOpen, Settings, RotateCcw, Cloud, Loader2,
  CheckCircle, XCircle, ChevronDown, RefreshCw, Server,
} from "lucide-react";
import { MultiSelectDropdown } from "@/components/ui/MultiSelectDropdown";

type TabKey = "connection" | "models" | "preferences" | "webdav";

const TABS: { key: TabKey; label: string }[] = [
  { key: "connection", label: "管理端" },
  { key: "models", label: "模型" },
  { key: "preferences", label: "生成偏好" },
  { key: "webdav", label: "WebDAV" },
];

const CAT_LABELS: Record<string, string> = {
  image: "生图",
  video: "视频",
  text: "文本",
  audio: "音频",
};

export function SettingsModal() {
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const [activeTab, setActiveTab] = useState<TabKey>("connection");

  // ── 基础 ──
  const userDataDir = useSettingsStore((s) => s.userDataDir);
  const setUserDataDir = useSettingsStore((s) => s.setUserDataDir);
  const [activeDir, setActiveDir] = useState("");

  // ── 默认模型 ─
  const imageDefaults = useSettingsStore((s) => s.imageDefaults);
  const videoDefaults = useSettingsStore((s) => s.videoDefaults);
  const textDefaults = useSettingsStore((s) => s.textDefaults);
  const audioDefaults = useSettingsStore((s) => s.audioDefaults);
  const setImageDefaults = useSettingsStore((s) => s.setImageDefaults);
  const setVideoDefaults = useSettingsStore((s) => s.setVideoDefaults);
  const setTextDefaults = useSettingsStore((s) => s.setTextDefaults);
  const setAudioDefaults = useSettingsStore((s) => s.setAudioDefaults);

  // ── WebDAV ──
  const enableCloudSync = useSettingsStore((s) => s.enableCloudSync);
  const setEnableCloudSync = useSettingsStore((s) => s.setEnableCloudSync);
  const webdavUrl = useSettingsStore((s) => s.webdavUrl);
  const setWebdavUrl = useSettingsStore((s) => s.setWebdavUrl);
  const webdavDirectory = useSettingsStore((s) => s.webdavDirectory);
  const setWebdavDirectory = useSettingsStore((s) => s.setWebdavDirectory);
  const webdavUsername = useSettingsStore((s) => s.webdavUsername);
  const setWebdavUsername = useSettingsStore((s) => s.setWebdavUsername);
  const webdavPassword = useSettingsStore((s) => s.webdavPassword);
  const setWebdavPassword = useSettingsStore((s) => s.setWebdavPassword);
  const [webdavTestStatus, setWebdavTestStatus] = useState<"idle" | "testing" | "ok" | "error">("idle");
  const [webdavTestMsg, setWebdavTestMsg] = useState("");

  useEffect(() => {
    useSettingsStore.getState().getActiveUserDataDir().then(setActiveDir);
  }, [userDataDir]);

  const handleChangeDir = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ directory: true, multiple: false }) as string | null;
      if (selected) setUserDataDir(selected);
    } catch (e) {
      console.error("Failed to pick folder", e);
    }
  };

  const handleTestWebdav = async () => {
    setWebdavTestStatus("testing");
    setWebdavTestMsg("");
    try {
      const { testConnection } = await import("@/services/webdavSync");
      await testConnection({ url: webdavUrl, directory: webdavDirectory, username: webdavUsername, password: webdavPassword });
      setWebdavTestStatus("ok");
      setWebdavTestMsg("连接成功");
    } catch (err) {
      setWebdavTestStatus("error");
      setWebdavTestMsg(err instanceof Error ? err.message : "连接失败");
    }
  };

  return (
    <div
      className="fixed inset-0 z-[20000] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-200"
      onClick={() => setSettingsOpen(false)}
    >
      <div
        className="Qiji-panel flex flex-col w-[640px] max-h-[85vh] rounded-2xl text-foreground shadow-2xl border border-white/10 overflow-hidden relative"
        style={{ border: "1px solid rgba(255, 255, 255, 0.1)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-0">
          <div>
            <div className="flex items-center gap-2">
              <Settings className="h-4 w-4 text-primary" />
              <h3 className="text-sm font-semibold text-foreground">配置与用户偏好</h3>
            </div>
            <p className="text-[10px] text-muted-foreground mt-0.5">管理端连接、模型选择和同步偏好</p>
          </div>
          <button
            onClick={() => setSettingsOpen(false)}
            className="text-muted-foreground hover:text-foreground hover:bg-secondary rounded-lg p-1 transition-colors cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-0 px-6 mt-4 border-b border-border/40">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`px-4 py-2.5 text-xs font-medium transition-colors cursor-pointer relative ${
                activeTab === tab.key ? "text-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {tab.label}
              {activeTab === tab.key && <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-primary rounded-t" />}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-5 Qiji-scroll-thin text-[11px]">
          {activeTab === "connection" && <ConnectionTab />}
          {activeTab === "models" && (
            <ModelsTab
              imageDefaults={imageDefaults}
              videoDefaults={videoDefaults}
              textDefaults={textDefaults}
              audioDefaults={audioDefaults}
              setImageDefaults={setImageDefaults}
              setVideoDefaults={setVideoDefaults}
              setTextDefaults={setTextDefaults}
              setAudioDefaults={setAudioDefaults}
            />
          )}
          {activeTab === "preferences" && (
            <PreferencesTab
              activeDir={activeDir}
              userDataDir={userDataDir}
              handleChangeDir={handleChangeDir}
              setUserDataDir={setUserDataDir}
            />
          )}
          {activeTab === "webdav" && (
            <WebdavTab
              enableCloudSync={enableCloudSync}
              setEnableCloudSync={setEnableCloudSync}
              webdavUrl={webdavUrl}
              setWebdavUrl={setWebdavUrl}
              webdavDirectory={webdavDirectory}
              setWebdavDirectory={setWebdavDirectory}
              webdavUsername={webdavUsername}
              setWebdavUsername={setWebdavUsername}
              webdavPassword={webdavPassword}
              setWebdavPassword={setWebdavPassword}
              webdavTestStatus={webdavTestStatus}
              webdavTestMsg={webdavTestMsg}
              handleTestWebdav={handleTestWebdav}
            />
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-6 py-4 border-t border-border/40">
          <button
            onClick={() => setSettingsOpen(false)}
            className="px-5 py-2 rounded-lg bg-secondary text-foreground hover:bg-secondary/80 font-semibold cursor-pointer transition-colors text-xs"
          >
            完成
          </button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════
// Tab 1: 管理端连接（服务器地址 + accessKey）
// ═══════════════════════════════════════════

function ConnectionTab() {
  const serverUrl = useConnectionStore((s) => s.serverUrl);
  const accessKey = useConnectionStore((s) => s.accessKey);
  const setServerUrl = useConnectionStore((s) => s.setServerUrl);
  const setAccessKey = useConnectionStore((s) => s.setAccessKey);
  const isConfigured = useConnectionStore((s) => s.isConfigured());

  const loading = useCatalogStore((s) => s.loading);
  const catalogError = useCatalogStore((s) => s.error);
  const catalog = useCatalogStore((s) => s.catalog);
  const modelCount = catalog?.models?.length ?? 0;

  const handleSync = () => {
    useCatalogStore.getState().syncCatalog();
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="bg-secondary/30 border border-border/30 rounded-lg p-3">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground mb-1">
          <Server className="h-3.5 w-3.5 text-primary" /> 管理端网关
        </div>
        <div className="text-[10px] text-muted-foreground leading-relaxed">
          用户端只与管理端通信，绝不直连第三方 API。所有模型、提示词模板、出图模板由管理端
          下发，凭下方的服务器地址 + 访问令牌（accessKey）连接并拉取目录（catalog）。
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-[10px] font-semibold text-muted-foreground">服务器地址</label>
        <input
          type="url"
          value={serverUrl}
          onChange={(e) => setServerUrl(e.target.value)}
          placeholder="https://gw.yourcompany.com"
          className="bg-secondary/60 border border-border/40 rounded-lg px-3 py-2 text-foreground font-mono text-[11px] focus:outline-none focus:border-primary w-full"
        />
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-[10px] font-semibold text-muted-foreground">访问令牌 accessKey</label>
        <input
          type="password"
          value={accessKey}
          onChange={(e) => setAccessKey(e.target.value)}
          placeholder="管理端签发的用户级令牌"
          className="bg-secondary/60 border border-border/40 rounded-lg px-3 py-2 text-foreground font-mono text-[11px] focus:outline-none focus:border-primary w-full"
        />
      </div>

      <div className="flex items-center gap-3 mt-1">
        <button
          onClick={handleSync}
          disabled={!isConfigured || loading}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground font-semibold hover:bg-primary/90 transition-colors cursor-pointer text-[10px] disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          测试连接并拉取目录
        </button>
        {!loading && catalogError && (
          <span className="flex items-center gap-1 text-[10px] text-destructive">
            <XCircle className="h-3 w-3" /> {catalogError}
          </span>
        )}
        {!loading && !catalogError && catalog && (
          <span className="flex items-center gap-1 text-[10px] text-green-400">
            <CheckCircle className="h-3 w-3" /> 目录版本 {catalog.version}，共 {modelCount} 个模型
          </span>
        )}
      </div>

      {!isConfigured && (
        <p className="text-[10px] text-muted-foreground">请先填写服务器地址与访问令牌。</p>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════
// Tab 2: 模型（来自管理端 catalog）
// ═══════════════════════════════════════════

function ModelsTab({
  imageDefaults, videoDefaults, textDefaults, audioDefaults,
  setImageDefaults, setVideoDefaults, setTextDefaults, setAudioDefaults,
}: {
  imageDefaults: { defaultModelId: string };
  videoDefaults: { defaultModelId: string };
  textDefaults: { defaultModelId: string };
  audioDefaults: { defaultModelId: string };
  setImageDefaults: (d: { defaultModelId: string }) => void;
  setVideoDefaults: (d: { defaultModelId: string }) => void;
  setTextDefaults: (d: { defaultModelId: string }) => void;
  setAudioDefaults: (d: { defaultModelId: string }) => void;
}) {
  const toggleSelectedModel = useSettingsStore((s) => s.toggleSelectedModel);
  const selectedModels = useSettingsStore((s) => s.selectedModels);
  // 订阅 catalog 变化以在拉取目录后刷新列表
  const catalogVersion = useCatalogStore((s) => s.catalog?.version);

  // 打开/目录更新时，清理设置里已失效的旧"已选模型"id（防止计数虚高）
  useEffect(() => {
    const models = useCatalogStore.getState().catalog?.models;
    if (!models?.length) return;
    const byCap: Record<string, string[]> = {};
    for (const m of models) (byCap[m.capability] ??= []).push(m.id);
    useSettingsStore.getState().pruneSelectedModels(byCap);
  }, [catalogVersion]);

  // 各能力的全部 catalog 模型（多选器选项）
  const allByCap: Record<Capability, ModelOption[]> = {
    image: getModelsForCapability("image"),
    video: getModelsForCapability("video"),
    text: getModelsForCapability("text"),
    audio: getModelsForCapability("audio"),
  };

  // 已启用的模型（默认模型下拉用）
  const enabledModels: Record<string, ModelOption[]> = {
    image: getChannelModelsForNodeType("image"),
    video: getChannelModelsForNodeType("video"),
    text: getChannelModelsForNodeType("text"),
    audio: getChannelModelsForNodeType("audio"),
  };

  const catGroups: { cat: Capability; selected: string[] }[] = [
    { cat: "image", selected: selectedModels.image ?? [] },
    { cat: "video", selected: selectedModels.video ?? [] },
    { cat: "text", selected: selectedModels.text ?? [] },
    { cat: "audio", selected: selectedModels.audio ?? [] },
  ];

  const defaultsMap: Record<string, { defaults: { defaultModelId: string }; setter: (d: { defaultModelId: string }) => void; models: ModelOption[] }> = {
    image: { defaults: imageDefaults, setter: setImageDefaults, models: enabledModels.image },
    video: { defaults: videoDefaults, setter: setVideoDefaults, models: enabledModels.video },
    text: { defaults: textDefaults, setter: setTextDefaults, models: enabledModels.text },
    audio: { defaults: audioDefaults, setter: setAudioDefaults, models: enabledModels.audio },
  };

  const totalAvailable = allByCap.image.length + allByCap.video.length + allByCap.text.length + allByCap.audio.length;

  return (
    <div className="flex flex-col gap-4">
      <div className="bg-secondary/30 border border-border/30 rounded-lg p-3">
        <div className="text-xs font-semibold text-foreground mb-1">模型分类与默认选择</div>
        <div className="text-[10px] text-muted-foreground">
          下列模型由管理端 catalog 下发。勾选需要启用的模型，它们会出现在节点面板的模型下拉框中；
          未勾选某类时，该类默认展示全部可用模型。管理端共下发 {totalAvailable} 个模型。
        </div>
      </div>

      {/* 上半区：每类一个下拉多选 + 已选标签区 */}
      <div className="grid grid-cols-2 gap-4">
        {catGroups.map(({ cat, selected }) => (
          <div key={cat} className="flex flex-col gap-1.5">
            <label className="text-[10px] font-semibold text-muted-foreground">
              {CAT_LABELS[cat]}模型
              <span className="ml-1 text-muted-foreground/60 font-normal">({selected.length})</span>
            </label>

            <MultiSelectDropdown
              groups={[
                {
                  label: "管理端",
                  items: allByCap[cat].map((m) => ({
                    id: m.id,
                    label: m.modelName,
                    selected: selected.includes(m.id),
                  })),
                },
              ].filter((g) => g.items.length > 0)}
              selectedIds={selected}
              onToggle={(id) => toggleSelectedModel(cat, id)}
              placeholder="选择模型..."
            />

            <div className="flex flex-wrap gap-1 min-h-[24px]">
              {selected.length === 0 ? (
                <span className="text-[10px] text-muted-foreground italic">未勾选（展示全部）</span>
              ) : (
                selected.map((id) => {
                  const model = allByCap[cat].find((m) => m.id === id);
                  if (!model) return null;
                  return (
                    <span
                      key={id}
                      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-primary/20 border border-primary/50 text-[10px] text-foreground"
                    >
                      <span>{model.modelName}</span>
                      <button
                        onClick={() => toggleSelectedModel(cat, id)}
                        className="text-muted-foreground hover:text-destructive cursor-pointer ml-0.5"
                      >
                        ×
                      </button>
                    </span>
                  );
                })
              )}
            </div>
          </div>
        ))}
      </div>

      {/* 下半区：每类默认模型 */}
      <div className="grid grid-cols-4 gap-3">
        {(["image", "video", "text", "audio"] as const).map((cat) => {
          const { defaults: d, setter, models } = defaultsMap[cat];
          return (
            <div key={cat} className="flex flex-col gap-1">
              <label className="text-[10px] font-semibold text-muted-foreground">默认{CAT_LABELS[cat]}模型</label>
              <div className="relative">
                <select
                  value={d.defaultModelId}
                  onChange={(e) => setter({ defaultModelId: e.target.value })}
                  className="w-full bg-secondary/60 border border-border/40 rounded-lg px-2 py-1.5 text-foreground text-[10px] focus:outline-none focus:border-primary cursor-pointer truncate appearance-none"
                >
                  <option value="">请选择</option>
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>{m.modelName}</option>
                  ))}
                </select>
                <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 pointer-events-none" style={{ opacity: 0.6, color: "var(--muted-foreground)" }} />
              </div>
            </div>
          );
        })}
      </div>

      {totalAvailable === 0 && (
        <div className="text-center py-6 text-muted-foreground text-xs">
          暂无可用模型。请先在「管理端」Tab 配置服务器地址并拉取目录{catalogVersion ? "" : ""}。
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════
// Tab 3: 生成偏好
// ═══════════════════════════════════════════

function PreferencesTab({
  activeDir, userDataDir,
  handleChangeDir, setUserDataDir,
}: {
  activeDir: string;
  userDataDir: string | null;
  handleChangeDir: () => void;
  setUserDataDir: (dir: string | null) => void;
}) {
  const online = useConnectionStore((s) => s.online);
  const serverUrl = useConnectionStore((s) => s.serverUrl);
  const catalog = useCatalogStore((s) => s.catalog);
  const modelCount = catalog?.models?.length ?? 0;

  return (
    <div className="flex flex-col gap-5">
      {/* 存储目录 */}
      <div className="flex flex-col gap-2">
        <label className="text-xs font-semibold text-foreground">用户数据存储目录</label>
        <div className="bg-secondary/60 border border-border/40 p-2.5 rounded-lg font-mono text-muted-foreground break-all select-all min-h-[42px] leading-relaxed text-[11px]">
          {activeDir || "正在解析..."}
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleChangeDir}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground font-semibold hover:bg-primary/90 transition-colors cursor-pointer text-[10px]"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            更改存储路径...
          </button>
          {userDataDir && (
            <button
              onClick={() => setUserDataDir(null)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border/80 text-muted-foreground font-semibold hover:bg-secondary transition-colors cursor-pointer text-[10px]"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              恢复默认
            </button>
          )}
        </div>
        <p className="text-[10px] text-muted-foreground leading-normal">
          此路径用于保存项目工程、渲染导出的多媒体资产以及历史快照。
        </p>
      </div>

      {/* 管理端概览 */}
      <div className="flex flex-col gap-3">
        <h4 className="text-xs font-semibold text-foreground">管理端概览</h4>
        <div className="bg-secondary/40 border border-border/30 rounded-lg p-3 flex items-center gap-4">
          <div className="flex flex-col items-center">
            <span className={`text-lg font-bold ${online ? "text-green-400" : "text-muted-foreground"}`}>
              {online ? "在线" : "离线"}
            </span>
            <span className="text-[9px] text-muted-foreground">连接状态</span>
          </div>
          <div className="h-8 w-[1px] bg-border/40" />
          <div className="flex flex-col items-center">
            <span className="text-lg font-bold text-foreground">{modelCount}</span>
            <span className="text-[9px] text-muted-foreground">可用模型</span>
          </div>
          <div className="h-8 w-[1px] bg-border/40" />
          <div className="flex flex-col items-center min-w-0">
            <span className="text-[11px] font-mono text-foreground truncate max-w-[220px]">{serverUrl || "未配置"}</span>
            <span className="text-[9px] text-muted-foreground">服务器地址</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════
// Tab 4: WebDAV
// ═══════════════════════════════════════════

function WebdavTab({
  enableCloudSync, setEnableCloudSync,
  webdavUrl, setWebdavUrl,
  webdavDirectory, setWebdavDirectory,
  webdavUsername, setWebdavUsername,
  webdavPassword, setWebdavPassword,
  webdavTestStatus, webdavTestMsg, handleTestWebdav,
}: {
  enableCloudSync: boolean;
  setEnableCloudSync: (v: boolean) => void;
  webdavUrl: string;
  setWebdavUrl: (v: string) => void;
  webdavDirectory: string;
  setWebdavDirectory: (v: string) => void;
  webdavUsername: string;
  setWebdavUsername: (v: string) => void;
  webdavPassword: string;
  setWebdavPassword: (v: string) => void;
  webdavTestStatus: "idle" | "testing" | "ok" | "error";
  webdavTestMsg: string;
  handleTestWebdav: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Cloud className="h-3.5 w-3.5 text-blue-400" />
          <span className="text-xs font-semibold text-foreground">WebDAV 云端同步</span>
        </div>
        <p className="text-[10px] text-muted-foreground">
          将项目文件备份到 WebDAV 服务器，支持坚果云等主流服务。保存后自动增量同步。
        </p>
      </div>

      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          id="enableCloudSync"
          checked={enableCloudSync}
          onChange={(e) => setEnableCloudSync(e.target.checked)}
          className="h-3.5 w-3.5 rounded accent-[var(--primary)]"
        />
        <label htmlFor="enableCloudSync" className="text-foreground text-[11px] cursor-pointer">
          启用云端同步
        </label>
      </div>

      {enableCloudSync && (
        <div className="flex flex-col gap-3 pl-1">
          <div className="flex flex-col gap-1">
            <label className="text-muted-foreground">服务器地址</label>
            <input
              type="url"
              value={webdavUrl}
              onChange={(e) => setWebdavUrl(e.target.value)}
              placeholder="https://dav.jianguoyun.com/dav/"
              className="bg-secondary/60 border border-border/40 rounded-lg px-3 py-2 text-foreground font-mono text-[11px] focus:outline-none focus:border-primary w-full"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-muted-foreground">远程目录</label>
            <input
              type="text"
              value={webdavDirectory}
              onChange={(e) => setWebdavDirectory(e.target.value)}
              placeholder="/qiji-projects"
              className="bg-secondary/60 border border-border/40 rounded-lg px-3 py-2 text-foreground font-mono text-[11px] focus:outline-none focus:border-primary w-full"
            />
          </div>
          <div className="flex gap-2">
            <div className="flex flex-col gap-1 flex-1">
              <label className="text-muted-foreground">用户名</label>
              <input
                type="text"
                value={webdavUsername}
                onChange={(e) => setWebdavUsername(e.target.value)}
                placeholder="your@email.com"
                className="bg-secondary/60 border border-border/40 rounded-lg px-3 py-2 text-foreground font-mono text-[11px] focus:outline-none focus:border-primary w-full"
              />
            </div>
            <div className="flex flex-col gap-1 flex-1">
              <label className="text-muted-foreground">密码 / 应用密码</label>
              <input
                type="password"
                value={webdavPassword}
                onChange={(e) => setWebdavPassword(e.target.value)}
                placeholder="••••••••"
                className="bg-secondary/60 border border-border/40 rounded-lg px-3 py-2 text-foreground font-mono text-[11px] focus:outline-none focus:border-primary w-full"
              />
            </div>
          </div>
          <div className="flex items-center gap-2 mt-1">
            <button
              onClick={handleTestWebdav}
              disabled={webdavTestStatus === "testing" || !webdavUrl.trim()}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground font-semibold hover:bg-primary/90 transition-colors cursor-pointer text-[10px] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {webdavTestStatus === "testing" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Cloud className="h-3.5 w-3.5" />}
              测试连接
            </button>
            {webdavTestStatus === "ok" && (
              <span className="flex items-center gap-1 text-[10px] text-green-400">
                <CheckCircle className="h-3 w-3" /> {webdavTestMsg}
              </span>
            )}
            {webdavTestStatus === "error" && (
              <span className="flex items-center gap-1 text-[10px] text-destructive">
                <XCircle className="h-3 w-3" /> {webdavTestMsg}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
