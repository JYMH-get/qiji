import { useState, useEffect } from "react";
import { useSettingsStore } from "@/store/settingsStore";
import { useUiStore } from "@/store/uiStore";
import { X, FolderOpen, Settings, RotateCcw } from "lucide-react";

export function SettingsModal() {
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  
  const userDataDir = useSettingsStore((s) => s.userDataDir);
  const setUserDataDir = useSettingsStore((s) => s.setUserDataDir);
  const apiKeys = useSettingsStore((s) => s.apiKeys);
  const setApiKey = useSettingsStore((s) => s.setApiKey);
  const defaultModelConfigs = useSettingsStore((s) => s.defaultModelConfigs);
  const setDefaultModelConfig = useSettingsStore((s) => s.setDefaultModelConfig);

  const [activeDir, setActiveDir] = useState<string>("");

  useEffect(() => {
    useSettingsStore.getState().getActiveUserDataDir().then(setActiveDir);
  }, [userDataDir]);

  const handleChangeDir = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        directory: true,
        multiple: false,
      }) as string | null;
      if (selected) {
        setUserDataDir(selected);
      }
    } catch (e) {
      console.error("Failed to pick folder", e);
    }
  };

  const handleRestoreDefault = () => {
    setUserDataDir(null);
  };

  return (
    <div 
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-200"
      onClick={() => setSettingsOpen(false)}
    >
      <div 
        className="Qiji-panel flex flex-col w-[460px] max-h-[85vh] rounded-2xl p-6 text-foreground shadow-2xl border border-white/10 overflow-hidden"
        style={{ border: "1px solid rgba(255, 255, 255, 0.1)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-border/40 mb-5">
          <div className="flex items-center gap-2">
            <Settings className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold text-foreground">系统设置</h3>
          </div>
          <button 
            onClick={() => setSettingsOpen(false)}
            className="text-muted-foreground hover:text-foreground hover:bg-secondary rounded-lg p-1 transition-colors cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto pr-1 Qiji-scroll-thin flex flex-col gap-6 text-[11px]">
          {/* Section 1: User Data Dir */}
          <div className="flex flex-col gap-2">
            <label className="font-semibold text-foreground">用户数据存储目录</label>
            <div className="flex flex-col gap-1.5">
              <div className="bg-secondary/60 border border-border/40 p-2.5 rounded-lg font-mono text-muted-foreground break-all select-all min-h-[42px] leading-relaxed">
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
                    onClick={handleRestoreDefault}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border/80 text-muted-foreground font-semibold hover:bg-secondary transition-colors cursor-pointer text-[10px]"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    恢复默认
                  </button>
                )}
              </div>
              <p className="text-[10px] text-muted-foreground leading-normal mt-0.5">
                说明：此路径用于保存项目工程、渲染导出的多媒体资产以及历史快照。更改路径后，新保存的项目将会存放在新位置。
              </p>
            </div>
          </div>

          <div className="h-[1px] bg-border/40" />

          {/* Section 2: API Keys */}
          <div className="flex flex-col gap-4">
            <h4 className="font-semibold text-foreground">模型接口 API 密钥</h4>
            
            <div className="flex flex-col gap-1.5">
              <label className="text-muted-foreground">OpenAI API Key</label>
              <input
                type="password"
                value={apiKeys["openai"] || ""}
                onChange={(e) => setApiKey("openai", e.target.value)}
                placeholder="sk-..."
                className="bg-secondary/60 border border-border/40 rounded-lg px-3 py-2 text-foreground font-mono focus:outline-none focus:border-primary w-full"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-muted-foreground">Stable Diffusion API Key</label>
              <input
                type="password"
                value={apiKeys["sd"] || ""}
                onChange={(e) => setApiKey("sd", e.target.value)}
                placeholder="输入 Stable Diffusion API 密钥..."
                className="bg-secondary/60 border border-border/40 rounded-lg px-3 py-2 text-foreground font-mono focus:outline-none focus:border-primary w-full"
              />
            </div>
          </div>

          <div className="h-[1px] bg-border/40" />

          {/* Section 3: Default Models */}
          <div className="flex flex-col gap-4">
            <h4 className="font-semibold text-foreground">默认生成模型</h4>
            
            <div className="flex flex-col gap-1.5">
              <label className="text-muted-foreground">文本/脚本模型 (Text Model)</label>
              <select
                value={defaultModelConfigs["text"] || "gpt-4o"}
                onChange={(e) => setDefaultModelConfig("text", e.target.value)}
                className="bg-secondary border border-border/40 rounded-lg px-2.5 py-1.5 text-foreground focus:outline-none focus:border-primary cursor-pointer w-full"
              >
                <option value="gpt-4o">gpt-4o (推荐)</option>
                <option value="gpt-4-turbo">gpt-4-turbo</option>
                <option value="claude-3-5-sonnet">claude-3-5-sonnet</option>
              </select>
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-muted-foreground">图像/画作模型 (Image Model)</label>
              <select
                value={defaultModelConfigs["image"] || "sd-xl"}
                onChange={(e) => setDefaultModelConfig("image", e.target.value)}
                className="bg-secondary border border-border/40 rounded-lg px-2.5 py-1.5 text-foreground focus:outline-none focus:border-primary cursor-pointer w-full"
              >
                <option value="sd-xl">Stable Diffusion XL (默认)</option>
                <option value="flux-dev">Flux Dev</option>
                <option value="midjourney-v6">Midjourney v6</option>
              </select>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 pt-4 border-t border-border/40 mt-5">
          <button
            onClick={() => setSettingsOpen(false)}
            className="px-4 py-2 rounded-lg bg-secondary text-foreground hover:bg-secondary/80 font-semibold cursor-pointer transition-colors"
          >
            完成
          </button>
        </div>
      </div>
    </div>
  );
}
