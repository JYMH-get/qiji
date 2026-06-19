import { X, Settings2, Sliders, LayoutGrid, ChevronDown } from "lucide-react";
import { useProjectStore } from "@/store/projectStore";
import { useUiStore } from "@/store/uiStore";
import { getChannelModelsForNodeType } from "@/services/adapters/channelAdapter";
import { useMemo } from "react";

export function ProjectSettingsModal() {
  const setProjectSettingsOpen = useUiStore((s) => s.setProjectSettingsOpen);
  const projectModelConfig = useProjectStore((s) => s.projectModelConfig) || {};
  const setProjectModelConfig = useProjectStore((s) => s.setProjectModelConfig);
  const projectName = useProjectStore((s) => s.name);

  // Retrieve enabled models by category
  const textModels = useMemo(() => getChannelModelsForNodeType("text"), []);
  const imageModels = useMemo(() => getChannelModelsForNodeType("image"), []);
  const videoModels = useMemo(() => getChannelModelsForNodeType("video"), []);
  const audioModels = useMemo(() => getChannelModelsForNodeType("audio"), []);

  const handleConfigChange = (key: string, value: string) => {
    setProjectModelConfig({ [key]: value });
  };

  const categories = [
    { key: "text", label: "文本模型", models: textModels },
    { key: "image", label: "图像模型", models: imageModels },
    { key: "video", label: "视频模型", models: videoModels },
    { key: "audio", label: "音频模型", models: audioModels },
  ];

  return (
    <div
      className="fixed inset-0 z-[20000] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-200"
      onClick={() => setProjectSettingsOpen(false)}
    >
      <div
        className="Qiji-panel flex flex-col w-[540px] rounded-2xl text-foreground shadow-2xl border border-white/10 overflow-hidden relative animate-in zoom-in-95 duration-150"
        style={{
          background: "rgba(22, 27, 38, 0.98)",
          border: "1px solid rgba(255, 255, 255, 0.1)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-0">
          <div>
            <div className="flex items-center gap-2">
              <Settings2 className="h-4 w-4 text-primary" />
              <h3 className="text-sm font-semibold text-foreground">项目模型配置</h3>
            </div>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              为项目「{projectName || "未命名项目"}」配置独立的模型规则
            </p>
          </div>
          <button
            onClick={() => setProjectSettingsOpen(false)}
            className="text-muted-foreground hover:text-foreground hover:bg-secondary rounded-lg p-1 transition-colors cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Info Box */}
        <div className="px-6 mt-4">
          <div className="bg-secondary/30 border border-border/20 rounded-xl p-3 text-[10px] text-muted-foreground leading-relaxed">
            此处是本项目的独立模型配置。未设置或选择「跟随全局默认」的模型，将自动回退到全局设置的默认模型。
          </div>
        </div>

        {/* Scroll Content */}
        <div className="flex-1 overflow-y-auto px-6 py-5 Qiji-scroll-thin text-[11px] flex flex-col gap-6 max-h-[60vh]">
          {/* Section 1: 表格模式 */}
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-1.5 border-b border-border/40 pb-2">
              <LayoutGrid className="h-3.5 w-3.5 text-primary/80" />
              <span className="text-xs font-semibold text-foreground">表格/资产模式 (填表创作工作流)</span>
            </div>
            <div className="grid grid-cols-2 gap-4">
              {categories.map((cat) => {
                const configKey = `table${cat.key.charAt(0).toUpperCase() + cat.key.slice(1)}`;
                const currentValue = (projectModelConfig as any)[configKey] || "";

                return (
                  <div key={cat.key} className="flex flex-col gap-1">
                    <label className="text-[10px] font-semibold text-muted-foreground">
                      {cat.label}
                    </label>
                    <div className="relative">
                      <select
                        value={currentValue}
                        onChange={(e) => handleConfigChange(configKey, e.target.value)}
                        className="w-full bg-secondary/60 border border-border/40 rounded-lg px-2.5 py-1.5 pr-8 text-foreground text-[10px] focus:outline-none focus:border-primary cursor-pointer truncate appearance-none"
                      >
                        <option value="">跟随全局默认</option>
                        {cat.models.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.modelName}（{m.channelName}）
                          </option>
                        ))}
                      </select>
                      <ChevronDown
                        className="absolute right-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 pointer-events-none"
                        style={{ opacity: 0.6, color: "var(--muted-foreground)" }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Section 2: 画布模式 */}
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-1.5 border-b border-border/40 pb-2">
              <Sliders className="h-3.5 w-3.5 text-primary/80" />
              <span className="text-xs font-semibold text-foreground">画布模式默认配置 (自由创作节点)</span>
            </div>
            <div className="grid grid-cols-2 gap-4">
              {categories.map((cat) => {
                const configKey = `canvas${cat.key.charAt(0).toUpperCase() + cat.key.slice(1)}`;
                const currentValue = (projectModelConfig as any)[configKey] || "";

                return (
                  <div key={cat.key} className="flex flex-col gap-1">
                    <label className="text-[10px] font-semibold text-muted-foreground">
                      画布默认{cat.label}
                    </label>
                    <div className="relative">
                      <select
                        value={currentValue}
                        onChange={(e) => handleConfigChange(configKey, e.target.value)}
                        className="w-full bg-secondary/60 border border-border/40 rounded-lg px-2.5 py-1.5 pr-8 text-foreground text-[10px] focus:outline-none focus:border-primary cursor-pointer truncate appearance-none"
                      >
                        <option value="">跟随全局默认</option>
                        {cat.models.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.modelName}（{m.channelName}）
                          </option>
                        ))}
                      </select>
                      <ChevronDown
                        className="absolute right-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 pointer-events-none"
                        style={{ opacity: 0.6, color: "var(--muted-foreground)" }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-6 py-4 border-t border-border/40">
          <button
            onClick={() => setProjectSettingsOpen(false)}
            className="px-5 py-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 font-semibold cursor-pointer transition-colors text-xs"
          >
            保存并完成
          </button>
        </div>
      </div>
    </div>
  );
}
