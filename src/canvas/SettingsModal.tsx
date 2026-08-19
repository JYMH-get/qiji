import { useState, useEffect } from "react";
import { useSettingsStore, DEFAULT_TIDY_ROW_GAP } from "@/store/settingsStore";
import { useConnectionStore } from "@/store/connectionStore";
import { useCatalogStore } from "@/store/catalogStore";
import { useUiStore } from "@/store/uiStore";
import {
  X, FolderOpen, Settings, RotateCcw, Cloud, Loader2,
  CheckCircle, XCircle, RefreshCw, Server, Keyboard,
  LayoutGrid, Plus, Trash2,
} from "lucide-react";
import { PRESET_CATEGORY } from "@/lib/presetSchemes";
import { versionLabel } from "@/lib/appVersion";
import {
  KEYMAP_ACTIONS, FIXED_KEYS, RESERVED_COMBOS,
  comboFromEvent, comboLabel, effectiveBinding,
} from "@/canvas/keymap";

// 第132轮删「模型」页（用户定）：模型全量默认可用、无勾选子集、无全局默认模型
//（未显式选择时自动取该能力第一个可用模型，选择在各生成界面的模型下拉里做、随项目落盘）。
type TabKey = "connection" | "presets" | "preferences" | "keymap" | "webdav";

const TABS: { key: TabKey; label: string }[] = [
  { key: "connection", label: "管理端" },
  { key: "presets", label: "预设方案" },
  { key: "preferences", label: "生成偏好" },
  { key: "keymap", label: "快捷键" },
  { key: "webdav", label: "WebDAV" },
];

export function SettingsModal() {
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const [activeTab, setActiveTab] = useState<TabKey>("connection");

  // 「无可用模型」入口经 openModelSettings 打开时定位到指定页签（消费后清空，手动打开不受影响）
  const settingsTab = useUiStore((s) => s.settingsTab);
  useEffect(() => {
    if (settingsTab) {
      setActiveTab(settingsTab);
      useUiStore.setState({ settingsTab: null });
    }
  }, [settingsTab]);

  // ── 基础 ──
  const userDataDir = useSettingsStore((s) => s.userDataDir);
  const setUserDataDir = useSettingsStore((s) => s.setUserDataDir);
  const [activeDir, setActiveDir] = useState("");

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
          {activeTab === "presets" && <PresetsTab />}
          {activeTab === "preferences" && (
            <PreferencesTab
              activeDir={activeDir}
              userDataDir={userDataDir}
              handleChangeDir={handleChangeDir}
              setUserDataDir={setUserDataDir}
            />
          )}
          {activeTab === "keymap" && <KeymapTab />}
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

        {/* Footer：左=客户端版本标识（排查构建用），右=完成 */}
        <div className="flex items-center justify-between gap-2 px-6 py-4 border-t border-border/40">
          <span className="text-[10px] text-muted-foreground/70 select-text" title="客户端版本 · 构建时间（区分新旧构建）">
            {versionLabel()}
          </span>
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
// Tab: 预设方案（自定义出图预设——本地，与服务端预设并列出现在图片节点预设下拉/胶囊）
// ═══════════════════════════════════════════

function PresetsTab() {
  const customPresets = useSettingsStore((s) => s.customPresets);
  const addCustomPreset = useSettingsStore((s) => s.addCustomPreset);
  const updateCustomPreset = useSettingsStore((s) => s.updateCustomPreset);
  const removeCustomPreset = useSettingsStore((s) => s.removeCustomPreset);
  // 服务端「预设方案」模板（只读展示，由管理端维护）
  const catalogVersion = useCatalogStore((s) => s.catalog?.version);
  const serverPresets = catalogVersion
    ? useCatalogStore.getState().templatesByCategory(PRESET_CATEGORY).filter((t) => (t.body ?? t.bodyPreview ?? "").trim())
    : [];

  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [group, setGroup] = useState("");
  const [position, setPosition] = useState<"prefix" | "suffix">("prefix");
  const add = () => {
    if (!body.trim()) return;
    addCustomPreset(name, body, group, position);
    setName("");
    setBody("");
    setGroup("");
    setPosition("prefix");
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="bg-secondary/30 border border-border/30 rounded-lg p-3">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground mb-1">
          <LayoutGrid className="h-3.5 w-3.5 text-primary" /> 出图预设方案
        </div>
        <div className="text-[10px] text-muted-foreground leading-relaxed">
          在画布图片节点的功能栏「▦ 预设方案」下拉里插入预设胶囊，提交时替换为完整预设词；<b>双击胶囊</b>可就地展开为可编辑正文。
          下方可添加你自己的常用预设（保存在本地），与管理端下发的预设一同出现。
          <br />可给预设设「互斥组」——同组预设不能同时出现（内置 <b>4/6/9 宫格</b>已互斥，插入其一会移除同组另一个）。
        </div>
      </div>

      {/* 新增自定义预设 */}
      <div className="flex flex-col gap-2 rounded-lg border border-border/30 p-3">
        <div className="text-[10px] font-semibold text-muted-foreground">新增自定义预设</div>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="预设名称（如：6宫格电影故事板）"
          className="bg-secondary/60 border border-border/40 rounded-lg px-3 py-2 text-foreground text-[11px] focus:outline-none focus:border-primary w-full"
        />
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="预设提示词正文……（插入胶囊后，提交时会替换成这段文本）"
          rows={4}
          className="bg-secondary/60 border border-border/40 rounded-lg px-3 py-2 text-foreground text-[11px] leading-relaxed focus:outline-none focus:border-primary w-full resize-y Qiji-scroll-thin"
        />
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground shrink-0">互斥组（规则）</span>
          <input
            type="text"
            value={group}
            onChange={(e) => setGroup(e.target.value)}
            placeholder="留空=无互斥；填「宫格」= 与 4/6/9 宫格预设互斥（同组只能存在一个）"
            className="flex-1 min-w-0 bg-secondary/60 border border-border/40 rounded-lg px-3 py-1.5 text-foreground text-[10px] focus:outline-none focus:border-primary"
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground shrink-0">插入位置</span>
          <select
            value={position}
            onChange={(e) => setPosition(e.target.value === "suffix" ? "suffix" : "prefix")}
            className="bg-secondary/60 border border-border/40 rounded-lg px-3 py-1.5 text-foreground text-[10px] focus:outline-none focus:border-primary"
          >
            <option value="prefix">前缀（用户输入前）</option>
            <option value="suffix">后缀（用户输入后）</option>
          </select>
        </div>
        <div className="flex justify-end">
          <button
            onClick={add}
            disabled={!body.trim()}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground font-semibold hover:bg-primary/90 transition-colors cursor-pointer text-[10px] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Plus className="h-3.5 w-3.5" /> 添加预设
          </button>
        </div>
      </div>

      {/* 自定义预设列表（可编辑/删除） */}
      <div className="flex flex-col gap-2">
        <div className="text-[10px] font-semibold text-muted-foreground">我的预设（{customPresets.length}）</div>
        {customPresets.length === 0 ? (
          <div className="text-[10px] text-muted-foreground italic px-1">还没有自定义预设。</div>
        ) : (
          customPresets.map((p) => (
            <div key={p.id} className="flex flex-col gap-1.5 rounded-lg border border-border/30 p-2.5">
              <div className="flex items-center gap-2">
                <span className="text-amber-300 text-xs shrink-0">▦</span>
                <input
                  type="text"
                  value={p.name}
                  onChange={(e) => updateCustomPreset(p.id, { name: e.target.value })}
                  placeholder="预设名称"
                  className="flex-1 min-w-0 bg-secondary/60 border border-border/40 rounded-md px-2 py-1 text-foreground text-[11px] font-semibold focus:outline-none focus:border-primary"
                />
                <button
                  onClick={() => removeCustomPreset(p.id)}
                  title="删除该预设"
                  className="shrink-0 text-muted-foreground hover:text-destructive cursor-pointer p-1"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              <textarea
                value={p.body}
                onChange={(e) => updateCustomPreset(p.id, { body: e.target.value })}
                rows={3}
                className="bg-secondary/60 border border-border/40 rounded-md px-2 py-1.5 text-foreground text-[11px] leading-relaxed focus:outline-none focus:border-primary w-full resize-y Qiji-scroll-thin"
              />
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-muted-foreground shrink-0">互斥组</span>
                <input
                  type="text"
                  value={p.group ?? ""}
                  onChange={(e) => updateCustomPreset(p.id, { group: e.target.value })}
                  placeholder="留空=无互斥；「宫格」= 与宫格预设互斥"
                  className="flex-1 min-w-0 bg-secondary/60 border border-border/40 rounded-md px-2 py-1 text-foreground text-[10px] focus:outline-none focus:border-primary"
                />
                <span className="text-[10px] text-muted-foreground shrink-0">位置</span>
                <select
                  value={p.position === "suffix" ? "suffix" : "prefix"}
                  onChange={(e) => updateCustomPreset(p.id, { position: e.target.value === "suffix" ? "suffix" : "prefix" })}
                  className="shrink-0 bg-secondary/60 border border-border/40 rounded-md px-2 py-1 text-foreground text-[10px] focus:outline-none focus:border-primary"
                >
                  <option value="prefix">前缀</option>
                  <option value="suffix">后缀</option>
                </select>
              </div>
            </div>
          ))
        )}
      </div>

      {/* 服务端预设（只读，由管理端维护） */}
      {serverPresets.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <div className="text-[10px] font-semibold text-muted-foreground">管理端预设（只读，共 {serverPresets.length}）</div>
          <div className="flex flex-wrap gap-1.5">
            {serverPresets.map((t) => (
              <span key={t.id} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-400/15 border border-amber-400/40 text-[10px] text-amber-200" title={t.body ?? t.bodyPreview ?? ""}>
                ▦ {t.name}
              </span>
            ))}
          </div>
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
  const depthGpu = useSettingsStore((s) => s.depthGpu);
  const setDepthGpu = useSettingsStore((s) => s.setDepthGpu);
  const depthVideoSmooth = useSettingsStore((s) => s.depthVideoSmooth);
  const setDepthVideoSmooth = useSettingsStore((s) => s.setDepthVideoSmooth);
  const gpuAvailable = typeof navigator !== "undefined" && !!(navigator as { gpu?: unknown }).gpu;

  return (
    <div className="flex flex-col gap-5">
      {/* 本地推理 GPU 加速（转深度；第202轮：模型已完全内置客户端，零网络零服务端依赖） */}
      <div className="flex flex-col gap-2">
        <label className="text-xs font-semibold text-foreground">本地推理（转深度）</label>
        <div className="bg-secondary/40 border border-border/30 rounded-lg p-3 flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="depthGpu"
              checked={depthGpu}
              onChange={(e) => setDepthGpu(e.target.checked)}
              className="h-3.5 w-3.5 rounded accent-[var(--primary)]"
            />
            <label htmlFor="depthGpu" className="text-foreground text-[11px] cursor-pointer">
              启用 GPU 加速（WebGPU）
            </label>
            <span className={`text-[9px] px-1.5 py-0.5 rounded ${gpuAvailable ? "bg-green-500/15 text-green-400" : "bg-secondary text-muted-foreground"}`}>
              {gpuAvailable ? "本机支持 WebGPU" : "本机未检测到 WebGPU"}
            </span>
          </div>
          <p className="text-[10px] text-muted-foreground leading-normal">
            转深度模型已内置在客户端，无需联网、无需连接服务端即可使用。开启 GPU 用核显/独显推理
            （约 0.2–0.5 秒）；关闭或本机不支持时自动改用 CPU 推理（约 1–3 秒，兼容性最好）。
            切换后对下一次转深度生效。
          </p>
          <div className="h-px bg-white/8" />
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="depthVideoSmooth"
              checked={depthVideoSmooth}
              onChange={(e) => setDepthVideoSmooth(e.target.checked)}
              className="h-3.5 w-3.5 rounded accent-[var(--primary)]"
            />
            <label htmlFor="depthVideoSmooth" className="text-foreground text-[11px] cursor-pointer">
              视频转深度：时间平滑归一化（防闪烁）
            </label>
          </div>
          <p className="text-[10px] text-muted-foreground leading-normal">
            视频转深度逐帧推理，每帧独立标定远近范围会产生可见闪烁。开启后相邻帧的标定范围做指数平滑，
            单镜头画面稳定（转场处约半秒渐变适应）；关闭则每帧独立归一化（与图片转深度同逻辑）。
            切换后对下一次视频转深度生效。
          </p>
        </div>
      </div>

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

// ═══════════════════════════════════════════
// Tab: 快捷键（画布模式）——注册表见 src/canvas/keymap.ts
// ═══════════════════════════════════════════

function KeymapTab() {
  const canvasKeymap = useSettingsStore((s) => s.canvasKeymap);
  const setKeymapBinding = useSettingsStore((s) => s.setKeymapBinding);
  const resetKeymap = useSettingsStore((s) => s.resetKeymap);
  const tidyRowGap = useSettingsStore((s) => s.tidyRowGap);
  const setTidyRowGap = useSettingsStore((s) => s.setTidyRowGap);
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [recordErr, setRecordErr] = useState("");
  // 整理间距输入草稿（失焦/回车才提交，提交时收敛到 0~400 整数）
  const [gapDraft, setGapDraft] = useState(String(tidyRowGap));
  useEffect(() => { setGapDraft(String(tidyRowGap)); }, [tidyRowGap]);
  const commitGap = () => {
    const n = Number(gapDraft);
    if (!Number.isFinite(n)) { setGapDraft(String(tidyRowGap)); return; }
    setTidyRowGap(n); // store 内归一化；useEffect 回填收敛后的值
  };

  // 录制模式：capture 抢在全局快捷键（画布/Ctrl+S 等）之前吃掉下一次按键
  useEffect(() => {
    if (!recordingId) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecordingId(null);
        setRecordErr("");
        return;
      }
      const combo = comboFromEvent(e);
      if (!combo) return; // 纯修饰键：继续等主键
      if (RESERVED_COMBOS.has(combo)) {
        setRecordErr(`「${comboLabel(combo)}」为固定功能/系统保留，请换一个`);
        return;
      }
      const overrides = useSettingsStore.getState().canvasKeymap;
      const clash = KEYMAP_ACTIONS.find(
        (a) => a.id !== recordingId && effectiveBinding(a.id, overrides) === combo,
      );
      if (clash) {
        setRecordErr(`「${comboLabel(combo)}」已被「${clash.label}」占用，请换一个或先改绑对方`);
        return;
      }
      const act = KEYMAP_ACTIONS.find((a) => a.id === recordingId);
      setKeymapBinding(recordingId, combo === act?.def ? "" : combo); // 录回默认键=清除覆盖
      setRecordingId(null);
      setRecordErr("");
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recordingId, setKeymapBinding]);

  // 分类保序去重
  const cats: string[] = [];
  for (const a of KEYMAP_ACTIONS) if (!cats.includes(a.category)) cats.push(a.category);
  const hasOverrides = Object.keys(canvasKeymap).length > 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="bg-secondary/30 border border-border/30 rounded-lg p-3">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground mb-1">
          <Keyboard className="h-3.5 w-3.5 text-primary" /> 画布快捷键
        </div>
        <div className="text-[10px] text-muted-foreground leading-relaxed">
          点击键位胶囊后按下新组合键即可改绑（Esc 取消录制）；仅画布模式生效，输入文字时自动让位。
        </div>
      </div>

      {recordErr && (
        <div className="flex items-center gap-1 text-[10px] text-destructive -mt-2">
          <XCircle className="h-3 w-3 shrink-0" /> {recordErr}
        </div>
      )}

      {/* 画布「整理」布局设置 */}
      <div className="flex flex-col gap-1">
        <div className="text-[10px] font-semibold text-muted-foreground">画布整理</div>
        <div className="flex flex-col rounded-lg border border-border/30 overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2">
            <span className="text-[11px] text-foreground">节点间距（高度）</span>
            <span className="text-[9px] text-muted-foreground/70 truncate flex-1 min-w-0">
              点「整理」时上下相邻节点之间的间距（px，0~400，默认 {DEFAULT_TIDY_ROW_GAP}）
            </span>
            {tidyRowGap !== DEFAULT_TIDY_ROW_GAP && (
              <button
                onClick={() => setTidyRowGap(DEFAULT_TIDY_ROW_GAP)}
                title={`恢复默认（${DEFAULT_TIDY_ROW_GAP}px）`}
                className="text-muted-foreground hover:text-foreground cursor-pointer shrink-0"
              >
                <RotateCcw className="h-3 w-3" />
              </button>
            )}
            <input
              type="number"
              min={0}
              max={400}
              step={4}
              value={gapDraft}
              onChange={(e) => setGapDraft(e.target.value)}
              onBlur={commitGap}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
              className={`shrink-0 w-[90px] rounded-md border px-2.5 py-1 text-[10px] font-mono text-center bg-secondary/60 text-foreground outline-none transition-colors focus:border-primary ${
                tidyRowGap !== DEFAULT_TIDY_ROW_GAP ? "border-primary/50" : "border-border/40"
              }`}
              title="失焦或回车生效"
            />
          </div>
        </div>
      </div>

      {cats.map((cat) => (
        <div key={cat} className="flex flex-col gap-1">
          <div className="text-[10px] font-semibold text-muted-foreground">{cat}</div>
          <div className="flex flex-col rounded-lg border border-border/30 overflow-hidden">
            {KEYMAP_ACTIONS.filter((a) => a.category === cat).map((a, i) => {
              const bound = effectiveBinding(a.id, canvasKeymap);
              const overridden = canvasKeymap[a.id] !== undefined && canvasKeymap[a.id] !== a.def;
              const recording = recordingId === a.id;
              return (
                <div
                  key={a.id}
                  className={`flex items-center gap-2 px-3 py-2 ${i > 0 ? "border-t border-border/20" : ""}`}
                >
                  <span className="text-[11px] text-foreground" title={a.desc}>{a.label}</span>
                  {a.desc && (
                    <span className="text-[9px] text-muted-foreground/70 truncate flex-1 min-w-0" title={a.desc}>
                      {a.desc}
                    </span>
                  )}
                  {!a.desc && <span className="flex-1" />}
                  {overridden && (
                    <button
                      onClick={() => { setKeymapBinding(a.id, ""); setRecordErr(""); }}
                      title={`恢复默认（${comboLabel(a.def)}）`}
                      className="text-muted-foreground hover:text-foreground cursor-pointer shrink-0"
                    >
                      <RotateCcw className="h-3 w-3" />
                    </button>
                  )}
                  <button
                    onClick={() => {
                      setRecordErr("");
                      setRecordingId(recording ? null : a.id);
                    }}
                    className={`shrink-0 min-w-[90px] rounded-md border px-2.5 py-1 text-[10px] font-mono transition-colors cursor-pointer text-center ${
                      recording
                        ? "border-primary text-primary bg-primary/10 animate-pulse"
                        : overridden
                          ? "border-primary/50 text-foreground bg-secondary/60 hover:border-primary"
                          : "border-border/40 text-foreground bg-secondary/60 hover:border-primary"
                    }`}
                    title={recording ? "按下新组合键（Esc 取消）" : "点击改绑"}
                  >
                    {recording ? "按下新键…" : comboLabel(bound)}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      <div className="flex items-center justify-between">
        <span className="text-[10px] text-muted-foreground">改动即时生效并随设置持久化</span>
        <button
          onClick={() => { resetKeymap(); setRecordingId(null); setRecordErr(""); }}
          disabled={!hasOverrides}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-secondary text-foreground hover:bg-secondary/80 font-semibold cursor-pointer transition-colors text-[10px] disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <RotateCcw className="h-3 w-3" /> 全部恢复默认
        </button>
      </div>

      <div className="flex flex-col gap-1">
        <div className="text-[10px] font-semibold text-muted-foreground">固定键（不可自定义）</div>
        <div className="flex flex-col rounded-lg border border-border/30 overflow-hidden">
          {FIXED_KEYS.map((f, i) => (
            <div
              key={f.keys}
              className={`flex items-center gap-2 px-3 py-1.5 ${i > 0 ? "border-t border-border/20" : ""}`}
            >
              <span className="shrink-0 min-w-[110px] text-[10px] font-mono text-muted-foreground">{f.keys}</span>
              <span className="text-[10px] text-muted-foreground/80">{f.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
