import { useState, useEffect } from "react";
import { useSettingsStore, type Channel, fetchModelsFromChannel, genChannelId } from "@/store/settingsStore";
import { useUiStore } from "@/store/uiStore";
import { getChannelModelsForNodeType, getAllChannelModels, type ModelOption } from "@/services/adapters/channelAdapter";
import {
  X, FolderOpen, Settings, RotateCcw, Cloud, Loader2,
  CheckCircle, XCircle, ChevronDown, ChevronUp, Plus, Trash2, RefreshCw, Eye, EyeOff,
} from "lucide-react";
import { MultiSelectDropdown } from "@/components/ui/MultiSelectDropdown";

type TabKey = "channels" | "models" | "preferences" | "webdav";

const TABS: { key: TabKey; label: string }[] = [
  { key: "channels", label: "渠道" },
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
  const [activeTab, setActiveTab] = useState<TabKey>("channels");

  // ── 自定义模型请求配置 ──
  const [editingRequestModelId, setEditingRequestModelId] = useState<string | null>(null);
  const [editingRequestModelName, setEditingRequestModelName] = useState<string | null>(null);
  const [editingRequestCategory, setEditingRequestCategory] = useState<string | null>(null);

  // ── 基础 ──
  const userDataDir = useSettingsStore((s) => s.userDataDir);
  const setUserDataDir = useSettingsStore((s) => s.setUserDataDir);
  const [activeDir, setActiveDir] = useState("");

  // ── 渠道 ──
  const channels = useSettingsStore((s) => s.channels);
  const addChannel = useSettingsStore((s) => s.addChannel);
  const updateChannel = useSettingsStore((s) => s.updateChannel);
  const removeChannel = useSettingsStore((s) => s.removeChannel);
  const setChannelModels = useSettingsStore((s) => s.setChannelModels);

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

  // ── 从所有渠道拉取模型 ──
  const [fetchingAll, setFetchingAll] = useState(false);
  const [fetchAllMsg, setFetchAllMsg] = useState("");
  const handleFetchAll = async () => {
    setFetchingAll(true);
    setFetchAllMsg("");
    let total = 0;
    for (const ch of channels) {
      if (!ch.baseUrl || !ch.apiKey) continue;
      try {
        const models = await fetchModelsFromChannel(ch.baseUrl, ch.apiKey);
        setChannelModels(ch.id, models);
        total += models.length;
      } catch (err) {
        setFetchAllMsg((prev) => (prev ? prev + "\n" : "") + `${ch.name}: ${err instanceof Error ? err.message : "拉取失败"}`);
      }
    }
    setFetchAllMsg((prev) => (prev ? prev + "\n" : "") + `完成，共拉取 ${total} 个模型`);
    setFetchingAll(false);
  };

  const handleAddChannel = () => {
    addChannel({
      id: genChannelId(),
      name: "新渠道",
      baseUrl: "",
      apiKey: "",
      models: [],
    });
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
            <p className="text-[10px] text-muted-foreground mt-0.5">渠道聚合、模型选择和同步偏好</p>
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
          {activeTab === "channels" && (
            <ChannelsTab
              channels={channels}
              addChannel={handleAddChannel}
              updateChannel={updateChannel}
              removeChannel={removeChannel}
              setChannelModels={setChannelModels}
              fetchingAll={fetchingAll}
              fetchAllMsg={fetchAllMsg}
              handleFetchAll={handleFetchAll}
            />
          )}
          {activeTab === "models" && (
            <ModelsTab
              channels={channels}
              imageDefaults={imageDefaults}
              videoDefaults={videoDefaults}
              textDefaults={textDefaults}
              audioDefaults={audioDefaults}
              setImageDefaults={setImageDefaults}
              setVideoDefaults={setVideoDefaults}
              setTextDefaults={setTextDefaults}
              setAudioDefaults={setAudioDefaults}
              onOpenRequestConfig={(id, modelName, cat) => {
                setEditingRequestModelId(id);
                setEditingRequestModelName(modelName);
                setEditingRequestCategory(cat);
              }}
            />
          )}
          {activeTab === "preferences" && (
            <PreferencesTab
              activeDir={activeDir}
              userDataDir={userDataDir}
              channels={channels}
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

        {/* Sub-overlay configuration panel */}
        {editingRequestModelId && (
          <RequestConfigEditor
            modelId={editingRequestModelId}
            modelName={editingRequestModelName!}
            category={editingRequestCategory!}
            onClose={() => setEditingRequestModelId(null)}
          />
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════
// Tab 1: 渠道
// ═══════════════════════════════════════════

function ChannelsTab({
  channels, addChannel, updateChannel, removeChannel, setChannelModels,
  fetchingAll, fetchAllMsg, handleFetchAll,
}: {
  channels: Channel[];
  addChannel: () => void;
  updateChannel: (id: string, patch: Partial<Omit<Channel, "id">>) => void;
  removeChannel: (id: string) => void;
  setChannelModels: (id: string, models: string[]) => void;
  fetchingAll: boolean;
  fetchAllMsg: string;
  handleFetchAll: () => void;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showKey, setShowKey] = useState<Record<string, boolean>>({});

  return (
    <div className="flex flex-col gap-5">
      {/* 多渠道聚合标题行 */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs font-semibold text-foreground">多渠道聚合</div>
          <div className="text-[10px] text-muted-foreground">
            每个渠道保存自己的 Base URL、API Key 和模型列表；模型选择时会显示模型名和渠道名。
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleFetchAll}
            disabled={fetchingAll || channels.length === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border/60 text-foreground text-[10px] cursor-pointer hover:bg-secondary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {fetchingAll ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            拉取全部
          </button>
          <button
            onClick={addChannel}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-[10px] font-semibold cursor-pointer hover:bg-primary/90 transition-colors"
          >
            <Plus className="h-3.5 w-3.5" />
            新增渠道
          </button>
        </div>
      </div>

      {fetchAllMsg && (
        <div className="bg-secondary/40 border border-border/30 rounded-lg p-2.5 text-[10px] text-muted-foreground whitespace-pre-wrap">
          {fetchAllMsg}
        </div>
      )}

      {channels.length === 0 && (
        <div className="text-center py-8 text-muted-foreground text-xs">
          暂无渠道，点击「新增渠道」添加第一个 API 入口
        </div>
      )}

      {channels.map((ch) => {
        const isExpanded = expandedId === ch.id;
        return (
          <div key={ch.id} className="border border-border/30 rounded-lg overflow-hidden">
            {/* 标题行 */}
            <div className="flex items-center justify-between px-3 py-2.5 bg-secondary/20">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setExpandedId(isExpanded ? null : ch.id)}
                  className="cursor-pointer"
                >
                  {isExpanded ? <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />}
                </button>
                <span className="text-[11px] font-semibold text-foreground">{ch.name}</span>
                <span className="text-[9px] text-muted-foreground">已保存 {ch.models.length} 个模型</span>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={async () => {
                    if (!ch.baseUrl || !ch.apiKey) return;
                    try {
                      const models = await fetchModelsFromChannel(ch.baseUrl, ch.apiKey);
                      setChannelModels(ch.id, models);
                    } catch (err) {
                      console.error("拉取模型失败:", err);
                    }
                  }}
                  disabled={!ch.baseUrl || !ch.apiKey}
                  className="flex items-center gap-1 px-2.5 py-1 rounded-md border border-border/40 text-[10px] text-foreground cursor-pointer hover:bg-secondary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <RefreshCw className="h-3 w-3" />
                  拉取模型
                </button>
                <button
                  onClick={() => removeChannel(ch.id)}
                  className="p-1 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 cursor-pointer transition-colors"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            {isExpanded && (
              <div className="px-3 pb-3 pt-2 flex flex-col gap-3">
                {/* 渠道名称 + Base URL */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1">
                    <label className="text-muted-foreground text-[10px]">渠道名称</label>
                    <input
                      value={ch.name}
                      onChange={(e) => updateChannel(ch.id, { name: e.target.value })}
                      className="bg-secondary/60 border border-border/40 rounded-lg px-3 py-2 text-foreground text-[11px] focus:outline-none focus:border-primary w-full"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-muted-foreground text-[10px]">Base URL</label>
                    <input
                      value={ch.baseUrl}
                      onChange={(e) => updateChannel(ch.id, { baseUrl: e.target.value })}
                      placeholder="https://api.example.com"
                      className="bg-secondary/60 border border-border/40 rounded-lg px-3 py-2 text-foreground font-mono text-[11px] focus:outline-none focus:border-primary w-full"
                    />
                  </div>
                </div>

                {/* API Key */}
                <div className="flex flex-col gap-1">
                  <label className="text-muted-foreground text-[10px]">API Key</label>
                  <div className="relative">
                    <input
                      type={showKey[ch.id] ? "text" : "password"}
                      value={ch.apiKey}
                      onChange={(e) => updateChannel(ch.id, { apiKey: e.target.value })}
                      placeholder="sk-xxxxxxxx"
                      className="bg-secondary/60 border border-border/40 rounded-lg px-3 py-2 pr-8 text-foreground font-mono text-[11px] focus:outline-none focus:border-primary w-full"
                    />
                    <button
                      onClick={() => setShowKey((prev) => ({ ...prev, [ch.id]: !prev[ch.id] }))}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground cursor-pointer"
                    >
                      {showKey[ch.id] ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    </button>
                  </div>
                </div>

                {/* 模型列表 */}
                {ch.models.length > 0 && (
                  <div className="flex flex-col gap-1">
                    <label className="text-muted-foreground text-[10px]">模型列表</label>
                    <div className="flex flex-wrap gap-1.5 max-h-[120px] overflow-y-auto">
                      {ch.models.map((m) => (
                        <span
                          key={m}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-white/8 border border-white/10 text-[10px] text-foreground"
                        >
                          {m}
                          <button
                            onClick={() => setChannelModels(ch.id, ch.models.filter((x) => x !== m))}
                            className="text-muted-foreground hover:text-destructive cursor-pointer ml-0.5"
                          >
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ═══════════════════════════════════════════
// Tab 2: 模型（默认模型选择）
// ═══════════════════════════════════════════

function ModelsTab({
  channels,
  imageDefaults, videoDefaults, textDefaults, audioDefaults,
  setImageDefaults, setVideoDefaults, setTextDefaults, setAudioDefaults,
  onOpenRequestConfig,
}: {
  channels: Channel[];
  imageDefaults: { defaultModelId: string };
  videoDefaults: { defaultModelId: string };
  textDefaults: { defaultModelId: string };
  audioDefaults: { defaultModelId: string };
  setImageDefaults: (d: { defaultModelId: string }) => void;
  setVideoDefaults: (d: { defaultModelId: string }) => void;
  setTextDefaults: (d: { defaultModelId: string }) => void;
  setAudioDefaults: (d: { defaultModelId: string }) => void;
  onOpenRequestConfig: (modelId: string, modelName: string, category: string) => void;
}) {
  const toggleSelectedModel = useSettingsStore((s) => s.toggleSelectedModel);
  const selectedModels = useSettingsStore((s) => s.selectedModels);

  // 所有渠道的所有模型（无分类无过滤，供下拉菜单使用）
  const allModels = getAllChannelModels();

  // 已选中的模型（用于默认模型下拉）
  const imageModels = getChannelModelsForNodeType("image");
  const videoModels = getChannelModelsForNodeType("video");
  const textModels = getChannelModelsForNodeType("text");
  const audioModels = getChannelModelsForNodeType("audio");

  const catGroups: { cat: string; selected: string[] }[] = [
    { cat: "image", selected: selectedModels.image ?? [] },
    { cat: "video", selected: selectedModels.video ?? [] },
    { cat: "text", selected: selectedModels.text ?? [] },
    { cat: "audio", selected: selectedModels.audio ?? [] },
  ];

  const defaultsMap: Record<string, { defaults: { defaultModelId: string }; setter: (d: { defaultModelId: string }) => void; models: ModelOption[] }> = {
    image: { defaults: imageDefaults, setter: setImageDefaults, models: imageModels },
    video: { defaults: videoDefaults, setter: setVideoDefaults, models: videoModels },
    text: { defaults: textDefaults, setter: setTextDefaults, models: textModels },
    audio: { defaults: audioDefaults, setter: setAudioDefaults, models: audioModels },
  };

  const totalSelected = imageModels.length + videoModels.length + textModels.length + audioModels.length;

  return (
    <div className="flex flex-col gap-4">
      <div className="bg-secondary/30 border border-border/30 rounded-lg p-3">
        <div className="text-xs font-semibold text-foreground mb-1">模型分类与默认选择</div>
        <div className="text-[10px] text-muted-foreground">
          从下拉菜单中选择模型（按渠道分组），选中的模型会出现在下方标签区及节点面板的模型下拉框中。共 {totalSelected} 个已启用模型。
        </div>
      </div>

      {/* 上半区：每类一个下拉菜单 + 已选标签区 */}
      <div className="grid grid-cols-2 gap-4">
        {catGroups.map(({ cat, selected }) => (
          <div key={cat} className="flex flex-col gap-1.5">
            <label className="text-[10px] font-semibold text-muted-foreground">
              {CAT_LABELS[cat]}模型
              <span className="ml-1 text-muted-foreground/60 font-normal">({selected.length})</span>
            </label>

            {/* 下拉菜单：按渠道分组的所有模型，多选连续选择 */}
            <MultiSelectDropdown
              groups={(() => {
                const selected = selectedModels[cat] ?? [];
                return channels
                  .filter((ch) => ch.baseUrl && ch.apiKey)
                  .map((ch) => {
                    const channelModels = allModels.filter((m) => m.channelName === ch.name);
                    return {
                      label: ch.name,
                      items: channelModels.map((m) => ({
                        id: m.id,
                        label: m.modelName,
                        selected: selected.includes(m.id),
                      })),
                    };
                  })
                  .filter((g) => g.items.length > 0);
              })()}
              selectedIds={selected}
              onToggle={(id) => toggleSelectedModel(cat, id)}
              placeholder="选择模型..."
            />

            {/* 已选标签区 */}
            <div className="flex flex-wrap gap-1 min-h-[24px]">
              {selected.length === 0 ? (
                <span className="text-[10px] text-muted-foreground italic">暂无已选模型</span>
              ) : (
                selected.map((id) => {
                  const model = allModels.find((m) => m.id === id);
                  if (!model) return null;
                  return (
                    <span
                      key={id}
                      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-primary/20 border border-primary/50 text-[10px] text-foreground"
                    >
                      <span>{model.modelName}</span>
                      <span className="text-[8px] opacity-60">({model.channelName})</span>
                      <button
                        onClick={() => onOpenRequestConfig(id, model.modelName, cat)}
                        className="text-muted-foreground hover:text-foreground cursor-pointer p-0.5 transition-colors"
                        title="自定义 HTTP 请求"
                      >
                        <Settings className="h-3 w-3" />
                      </button>
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

      {/* 下半区：每类默认模型选择（只列出已选中的模型） */}
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
                    <option key={m.id} value={m.id}>{m.modelName}（{m.channelName}）</option>
                  ))}
                </select>
                <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 pointer-events-none" style={{ opacity: 0.6, color: "var(--muted-foreground)" }} />
              </div>
            </div>
          );
        })}
      </div>

      {totalSelected === 0 && (
        <div className="text-center py-6 text-muted-foreground text-xs">
          请先在「渠道」Tab 添加渠道并拉取模型，然后在此处选择需要启用的模型
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════
// Tab 3: 生成偏好
// ══════════════════════════════════════════

function PreferencesTab({
  activeDir, userDataDir, channels,
  handleChangeDir, setUserDataDir,
}: {
  activeDir: string;
  userDataDir: string | null;
  channels: Channel[];
  handleChangeDir: () => void;
  setUserDataDir: (dir: string | null) => void;
}) {
  const totalModels = channels.reduce((sum, ch) => sum + ch.models.length, 0);
  const configuredChannels = channels.filter((ch) => ch.apiKey).length;

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

      {/* 渠道概览 */}
      <div className="flex flex-col gap-3">
        <h4 className="text-xs font-semibold text-foreground">渠道概览</h4>
        <div className="bg-secondary/40 border border-border/30 rounded-lg p-3 flex items-center gap-4">
          <div className="flex flex-col items-center">
            <span className="text-lg font-bold text-foreground">{channels.length}</span>
            <span className="text-[9px] text-muted-foreground">渠道数</span>
          </div>
          <div className="h-8 w-[1px] bg-border/40" />
          <div className="flex flex-col items-center">
            <span className="text-lg font-bold text-foreground">{configuredChannels}</span>
            <span className="text-[9px] text-muted-foreground">已配置密钥</span>
          </div>
          <div className="h-8 w-[1px] bg-border/40" />
          <div className="flex flex-col items-center">
            <span className="text-lg font-bold text-foreground">{totalModels}</span>
            <span className="text-[9px] text-muted-foreground">模型总数</span>
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

function RequestConfigEditor({
  modelId,
  modelName,
  category,
  onClose,
}: {
  modelId: string;
  modelName: string;
  category: string;
  onClose: () => void;
}) {
  const settings = useSettingsStore();
  const templates = settings.requestTemplates || [];
  const existingConfig = settings.modelRequests?.[modelId];

  let defaultUrl = "/v1/chat/completions";
  let defaultBody = `{
  "model": "{{model}}",
  "messages": [
    {
      "role": "user",
      "content": "{{input}}"
    }
  ],
  "temperature": 0.7
}`;
  if (category === "image") {
    defaultUrl = "/v1/images/generations";
    defaultBody = `{
  "model": "{{model}}",
  "prompt": "{{input}}",
  "size": "{{size}}",
  "n": {{quantity}}
}`;
  } else if (category === "video") {
    defaultUrl = "/v1/videos";
    defaultBody = `{
  "model": "{{model}}",
  "prompt": "{{input}}",
  "duration": {{duration}},
  "aspect_ratio": "{{aspect_ratio}}"
}`;
  } else if (category === "audio") {
    defaultUrl = "/v1/audio/speech";
    defaultBody = `{
  "model": "{{model}}",
  "input": "{{input}}",
  "voice": "{{voice}}"
}`;
  }

  const [requestType, setRequestType] = useState<"default" | "custom">(
    existingConfig?.requestType || "default"
  );
  const [method, setMethod] = useState(existingConfig?.method || "POST");
  const [url, setUrl] = useState(existingConfig?.url || defaultUrl);
  const [headersText, setHeadersText] = useState(
    existingConfig?.headers
      ? JSON.stringify(existingConfig.headers, null, 2)
      : '{\n  "Content-Type": "application/json"\n}'
  );
  const [bodyTemplate, setBodyTemplate] = useState(
    existingConfig?.bodyTemplate || defaultBody
  );
  
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [errorMsg, setErrorMsg] = useState("");

  const handleApplyTemplate = (tid: string) => {
    setSelectedTemplateId(tid);
    if (!tid) return;
    const t = templates.find((x) => x.id === tid);
    if (t) {
      setMethod(t.method);
      setUrl(t.url);
      setHeadersText(JSON.stringify(t.headers, null, 2));
      setBodyTemplate(t.bodyTemplate);
    }
  };

  const handleSaveAsTemplate = () => {
    if (!templateName.trim()) {
      setErrorMsg("请输入模板名称");
      return;
    }
    let parsedHeaders = {};
    try {
      parsedHeaders = JSON.parse(headersText);
    } catch {
      setErrorMsg("请求头不是有效的 JSON 格式");
      return;
    }

    const newTemplate = {
      id: `tpl-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      name: templateName.trim(),
      method,
      url,
      headers: parsedHeaders,
      bodyTemplate,
    };
    settings.addRequestTemplate(newTemplate);
    setSelectedTemplateId(newTemplate.id);
    setTemplateName("");
    setErrorMsg("已成功保存为模板！");
    setTimeout(() => setErrorMsg(""), 2000);
  };

  const handleSave = () => {
    let parsedHeaders = {};
    try {
      parsedHeaders = JSON.parse(headersText);
    } catch {
      setErrorMsg("请求头不是有效的 JSON 格式");
      return;
    }

    settings.setModelRequestConfig(modelId, {
      requestType,
      method,
      url,
      headers: parsedHeaders,
      bodyTemplate,
    });
    onClose();
  };

  return (
    <div className="absolute inset-0 z-[20010] flex items-center justify-center bg-black/60 backdrop-blur-md px-6 py-5 animate-in fade-in duration-200">
      <div 
        className="Qiji-panel flex flex-col w-[540px] max-h-[85vh] rounded-2xl text-foreground shadow-2xl border border-white/10 overflow-hidden"
        style={{ border: "1px solid rgba(255, 255, 255, 0.1)", background: "rgba(18, 22, 33, 0.98)" }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-white/5">
          <div>
            <h4 className="text-xs font-semibold text-foreground">
              配置模型请求: <span className="text-primary">{modelName}</span>
            </h4>
            <p className="text-[10px] text-muted-foreground mt-0.5">单独为该模型定制 HTTP 请求体或绑定模板</p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground p-1 cursor-pointer">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-4 text-[10px] Qiji-scroll-thin">
          {errorMsg && (
            <div className={`p-2 rounded text-[10px] ${errorMsg.includes("成功") ? "bg-green-500/10 border border-green-500/20 text-green-400" : "bg-red-500/10 border border-red-500/20 text-red-400"}`}>
              {errorMsg}
            </div>
          )}

          {/* Request Type Selector */}
          <div className="flex flex-col gap-1.5">
            <label className="text-muted-foreground font-semibold">请求方式选择</label>
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input 
                  type="radio" 
                  name="requestType" 
                  checked={requestType === "default"} 
                  onChange={() => setRequestType("default")}
                  className="accent-primary" 
                />
                <span>默认标准请求 (Standard OpenAI API)</span>
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input 
                  type="radio" 
                  name="requestType" 
                  checked={requestType === "custom"} 
                  onChange={() => setRequestType("custom")}
                  className="accent-primary" 
                />
                <span>自定义标准请求 (占位符替换)</span>
              </label>
            </div>
          </div>

          {requestType === "custom" && (
            <>
              {/* Template Binder */}
              <div className="grid grid-cols-2 gap-3 border-t border-white/5 pt-3">
                <div className="flex flex-col gap-1">
                  <label className="text-muted-foreground">快速绑定模板</label>
                  <select
                    value={selectedTemplateId}
                    onChange={(e) => handleApplyTemplate(e.target.value)}
                    className="bg-secondary/60 border border-border/40 rounded-lg px-2 py-1.5 text-foreground text-[10px] focus:outline-none focus:border-primary cursor-pointer"
                  >
                    <option value="">-- 选择模板 --</option>
                    {templates.map((t) => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </select>
                </div>
                
                <div className="flex flex-col gap-1">
                  <label className="text-muted-foreground">保存当前配置为模板</label>
                  <div className="flex gap-1.5">
                    <input
                      type="text"
                      placeholder="模板名称..."
                      value={templateName}
                      onChange={(e) => setTemplateName(e.target.value)}
                      className="flex-1 bg-secondary/60 border border-border/40 rounded-lg px-2 py-1 text-foreground text-[10px] focus:outline-none focus:border-primary"
                    />
                    <button
                      onClick={handleSaveAsTemplate}
                      className="px-2.5 py-1 rounded-lg bg-primary/20 text-primary border border-primary/40 hover:bg-primary/30 transition-colors font-medium cursor-pointer"
                    >
                      另存为
                    </button>
                  </div>
                </div>
              </div>

              {/* URL & Method */}
              <div className="grid grid-cols-4 gap-3 border-t border-white/5 pt-3">
                <div className="flex flex-col gap-1">
                  <label className="text-muted-foreground">方法</label>
                  <select
                    value={method}
                    onChange={(e) => setMethod(e.target.value)}
                    className="bg-secondary/60 border border-border/40 rounded-lg px-2 py-1.5 text-foreground text-[10px] focus:outline-none focus:border-primary cursor-pointer"
                  >
                    <option value="POST">POST</option>
                    <option value="GET">GET</option>
                    <option value="PUT">PUT</option>
                    <option value="DELETE">DELETE</option>
                  </select>
                </div>
                <div className="col-span-3 flex flex-col gap-1">
                  <label className="text-muted-foreground">请求地址 (Endpoint / URL)</label>
                  <input
                    type="text"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="如: /v1/chat/completions 或完整 https URL"
                    className="bg-secondary/60 border border-border/40 rounded-lg px-3 py-1.5 text-foreground text-[10px] focus:outline-none focus:border-primary font-mono w-full"
                  />
                </div>
              </div>

              {/* Custom Headers */}
              <div className="flex flex-col gap-1">
                <label className="text-muted-foreground">自定义请求头 (Headers JSON)</label>
                <textarea
                  value={headersText}
                  onChange={(e) => setHeadersText(e.target.value)}
                  rows={2}
                  className="bg-secondary/60 border border-border/40 rounded-lg p-2 text-foreground text-[10px] font-mono focus:outline-none focus:border-primary"
                  placeholder='{\n  "Content-Type": "application/json"\n}'
                />
              </div>

              {/* Body Template */}
              <div className="flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <label className="text-muted-foreground">请求体模板 (Request Body Template)</label>
                  <span className="text-muted-foreground/60 text-[8px]">
                    占位符: <code className="text-primary font-mono select-all">{"{{input}}"}</code> (输入提示词), <code className="text-primary font-mono select-all">{"{{model}}"}</code> (模型)
                  </span>
                </div>
                <textarea
                  value={bodyTemplate}
                  onChange={(e) => setBodyTemplate(e.target.value)}
                  rows={6}
                  className="bg-secondary/60 border border-border/40 rounded-lg p-2 text-foreground text-[10px] font-mono focus:outline-none focus:border-primary Qiji-scroll-thin"
                  placeholder="{...}"
                />
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-white/5 bg-secondary/10">
          {selectedTemplateId && (
            <button
              onClick={() => {
                settings.removeRequestTemplate(selectedTemplateId);
                setSelectedTemplateId("");
                setErrorMsg("模板已删除");
                setTimeout(() => setErrorMsg(""), 2000);
              }}
              className="mr-auto text-[10px] text-destructive hover:underline cursor-pointer"
            >
              删除该模板
            </button>
          )}
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg bg-secondary text-foreground hover:bg-secondary/80 font-semibold cursor-pointer text-[10px]"
          >
            取消
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-1.5 rounded-lg bg-primary text-primary-foreground font-semibold hover:bg-primary/90 cursor-pointer text-[10px]"
          >
            应用配置
          </button>
        </div>
      </div>
    </div>
  );
}