import { useState } from "react";
import { useUiStore } from "@/store/uiStore";
import { useProjectStore } from "@/store/projectStore";
import {
  Plus,
  FolderOpen,
  Upload,
  Trash2,
  Clock,
  LogOut,
  ChevronRight,
  Sparkles,
  FileCode2,
  X
} from "lucide-react";

export function DashboardPage() {
  const currentUser = useUiStore((s) => s.currentUser);
  const setCurrentUser = useUiStore((s) => s.setCurrentUser);
  const setScreen = useUiStore((s) => s.setScreen);

  const recentProjects = useProjectStore((s) => s.recentProjects);

  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [newProjName, setNewProjName] = useState("");
  const [searchQuery, setSearchQuery] = useState("");

  const handleLogout = () => {
    setCurrentUser(null);
    setScreen("login");
  };

  const handleCreateProject = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newProjName.trim() || "未命名项目";

    // 1. 初始化项目状态
    useProjectStore.getState().newProject();
    // 2. 设置项目名称
    useProjectStore.getState().setName(name);
    // 3. 切换到画布界面
    setScreen("canvas");
    setCreateModalOpen(false);
    setNewProjName("");
  };

  const handleOpenLocalProject = async () => {
    await useProjectStore.getState().open();
    // 如果成功加载了项目路径，跳转至画布
    if (useProjectStore.getState().savePath) {
      setScreen("canvas");
    }
  };

  const handleImportProject = async () => {
    await useProjectStore.getState().importProject();
    // 如果成功加载了项目路径，跳转至画布
    if (useProjectStore.getState().savePath) {
      setScreen("canvas");
    }
  };

  const handleLoadRecentProject = async (path: string) => {
    const success = await useProjectStore.getState().loadFromPath(path);
    if (success) {
      setScreen("canvas");
    }
  };

  const handleRemoveRecentProject = (e: React.MouseEvent, path: string) => {
    e.stopPropagation(); // 阻止触发卡片点击

    const list = recentProjects.filter((r) => r.path !== path);
    localStorage.setItem("Qiji:recentProjects", JSON.stringify(list));
    useProjectStore.setState({ recentProjects: list });
  };

  const filteredRecent = recentProjects.filter((p) =>
    p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    p.path.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="relative w-full h-full min-h-screen bg-[#07080a] text-foreground flex flex-col select-none overflow-x-hidden font-sans pt-8">
      {/* 背景流光 */}
      <div className="absolute -top-[10%] -left-[10%] w-[500px] h-[500px] bg-primary/5 rounded-full blur-[140px] pointer-events-none" />
      <div className="absolute top-[40%] right-[-10%] w-[400px] h-[400px] bg-purple-500/5 rounded-full blur-[120px] pointer-events-none" />

      {/* 头部 Header */}
      <header className="w-full h-14 bg-card/40 backdrop-blur-md border-b border-white/5 px-6 flex items-center justify-between z-10 shrink-0">
        <div className="flex items-center gap-2">
          <div className="h-7 w-7 rounded-lg bg-gradient-to-tr from-primary to-purple-500 flex items-center justify-center text-primary-foreground font-black text-sm">
            Q
          </div>
          <span className="font-bold text-sm tracking-wide bg-gradient-to-r from-foreground to-muted-foreground bg-clip-text text-transparent">
            Qiji 工作台
          </span>
          <span className="text-[10px] bg-primary/10 border border-primary/20 text-primary px-1.5 py-0.5 rounded font-mono uppercase">
            v2.1
          </span>
        </div>

        {/* 用户状态 */}
        <div className="flex items-center gap-3">
          <div className="flex flex-col items-end">
            <span className="text-[11px] font-semibold text-foreground">
              {currentUser || "未登录"}
            </span>
            <span className="text-[9px] text-muted-foreground">账户已连接</span>
          </div>
          <div className="h-8 w-8 rounded-full bg-secondary border border-white/10 flex items-center justify-center font-bold text-xs text-primary shadow-inner">
            {(currentUser || "U").slice(0, 1).toUpperCase()}
          </div>
          <div className="h-4 w-[1px] bg-white/10 mx-1" />
          <button
            onClick={handleLogout}
            title="退出登录"
            className="flex items-center justify-center h-8 w-8 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors cursor-pointer"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </header>

      {/* 主体 Content */}
      <main className="flex-1 w-full max-w-6xl mx-auto px-6 py-8 flex flex-col gap-8 overflow-y-auto Qiji-scroll-thin">
        {/* 欢迎语 */}
        <div className="flex items-center justify-between shrink-0">
          <div>
            <h2 className="text-xl font-bold tracking-tight">
              工作台大厅
            </h2>
            <p className="text-xs text-muted-foreground mt-1">
              在这里创建新作品，或管理、切换你最近的画布项目
            </p>
          </div>
          <div className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-secondary/50 border border-white/5 text-[10px] text-primary font-semibold">
            <Sparkles className="h-3.5 w-3.5" />
            <span>AI 辅助创作已启用</span>
          </div>
        </div>

        {/* 核心操作网格 */}
        <section className="grid grid-cols-1 md:grid-cols-3 gap-5 shrink-0">
          {/* 新建项目卡片 */}
          <div
            onClick={() => setCreateModalOpen(true)}
            className="group relative bg-card/40 hover:bg-card/75 border border-white/10 hover:border-primary/45 rounded-2xl p-6 shadow-lg flex flex-col gap-4 cursor-pointer transition-all duration-300"
          >
            <div className="h-10 w-10 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center text-primary group-hover:scale-110 transition-transform">
              <Plus className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-foreground group-hover:text-primary transition-colors">
                新建画布项目
              </h3>
              <p className="text-xs text-muted-foreground leading-normal mt-1">
                创建空白画卷，使用数据流和富媒体节点进行可视化节点编排创作。
              </p>
            </div>
            <div className="text-[10px] text-primary/80 font-bold flex items-center gap-0.5 mt-auto group-hover:translate-x-1 transition-transform">
              立即创建 <ChevronRight className="h-3 w-3" />
            </div>
          </div>

          {/* 打开本地项目 */}
          <div
            onClick={handleOpenLocalProject}
            className="group relative bg-card/40 hover:bg-card/75 border border-white/10 hover:border-primary/45 rounded-2xl p-6 shadow-lg flex flex-col gap-4 cursor-pointer transition-all duration-300"
          >
            <div className="h-10 w-10 rounded-xl bg-purple-500/10 border border-purple-500/20 flex items-center justify-center text-purple-400 group-hover:scale-110 transition-transform">
              <FolderOpen className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-foreground group-hover:text-purple-400 transition-colors">
                打开本地项目...
              </h3>
              <p className="text-xs text-muted-foreground leading-normal mt-1">
                浏览本地磁盘中的 .Qiji 扩展名项目文件，并恢复至画布中修改。
              </p>
            </div>
            <div className="text-[10px] text-purple-400/80 font-bold flex items-center gap-0.5 mt-auto group-hover:translate-x-1 transition-transform">
              浏览磁盘 <ChevronRight className="h-3 w-3" />
            </div>
          </div>

          {/* 导入项目压缩包 */}
          <div
            onClick={handleImportProject}
            className="group relative bg-card/40 hover:bg-card/75 border border-white/10 hover:border-primary/45 rounded-2xl p-6 shadow-lg flex flex-col gap-4 cursor-pointer transition-all duration-300"
          >
            <div className="h-10 w-10 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400 group-hover:scale-110 transition-transform">
              <Upload className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-foreground group-hover:text-amber-400 transition-colors">
                导入项目存档 (.zip)
              </h3>
              <p className="text-xs text-muted-foreground leading-normal mt-1">
                导入包含资产素材的 ZIP 压缩存档包。系统将解压并完成工程重构。
              </p>
            </div>
            <div className="text-[10px] text-amber-400/80 font-bold flex items-center gap-0.5 mt-auto group-hover:translate-x-1 transition-transform">
              导入存档 <ChevronRight className="h-3 w-3" />
            </div>
          </div>
        </section>

        {/* 最近项目列表 */}
        <section className="flex-1 flex flex-col gap-4 min-h-[300px]">
          <div className="flex items-center justify-between border-b border-white/5 pb-2 shrink-0">
            <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
              <Clock className="h-3.5 w-3.5" /> 最近打开的项目
            </h3>

            {/* 搜索框 */}
            {recentProjects.length > 0 && (
              <input
                type="text"
                placeholder="搜索最近项目..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="bg-secondary/40 border border-white/5 focus:border-primary/60 rounded px-2.5 py-1 text-[11px] text-foreground outline-none transition-colors w-48"
              />
            )}
          </div>

          {recentProjects.length === 0 ? (
            <div className="flex-1 border border-dashed border-white/5 rounded-2xl flex flex-col items-center justify-center p-8 text-center text-muted-foreground">
              <FileCode2 className="h-10 w-10 text-muted-foreground/40 mb-3" />
              <p className="text-xs">暂无最近打开的项目记录</p>
              <p className="text-[10px] mt-1 text-muted-foreground/60">
                可以通过上方操作“新建项目”或者“打开本地项目”来开启工作流
              </p>
            </div>
          ) : filteredRecent.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center p-8 text-center text-muted-foreground">
              <p className="text-xs">未搜索到匹配的项目</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {filteredRecent.map((p) => (
                <div
                  key={p.path}
                  onClick={() => handleLoadRecentProject(p.path)}
                  className="group flex items-center justify-between p-4 bg-card/30 hover:bg-card/65 border border-white/5 hover:border-white/10 rounded-xl cursor-pointer transition-all duration-200"
                >
                  <div className="flex items-center gap-3 overflow-hidden pr-2">
                    <div className="h-9 w-9 rounded-lg bg-secondary border border-white/5 flex items-center justify-center text-muted-foreground group-hover:text-primary transition-colors shrink-0">
                      <FileCode2 className="h-4.5 w-4.5" />
                    </div>
                    <div className="flex flex-col gap-0.5 overflow-hidden">
                      <span className="text-xs font-bold text-foreground truncate group-hover:text-primary transition-colors">
                        {p.name}
                      </span>
                      <span className="text-[10px] text-muted-foreground font-mono truncate" title={p.path}>
                        {p.path}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-4 shrink-0">
                    <span className="text-[9px] text-muted-foreground text-right hidden sm:block">
                      {new Date(p.openedAt).toLocaleString("zh-CN", {
                        month: "2-digit",
                        day: "2-digit",
                        hour: "2-digit",
                        minute: "2-digit"
                      })}
                    </span>
                    <button
                      onClick={(e) => handleRemoveRecentProject(e, p.path)}
                      title="从列表中移除"
                      className="h-7 w-7 rounded-md flex items-center justify-center text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </main>

      {/* 创建新项目 Modal */}
      {createModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-card border border-white/10 w-[360px] rounded-xl p-6 shadow-2xl flex flex-col gap-4">
            <div className="flex justify-between items-center pb-2 border-b border-white/5">
              <span className="text-sm font-bold">新建画布项目</span>
              <button
                onClick={() => setCreateModalOpen(false)}
                className="text-muted-foreground hover:text-foreground cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleCreateProject} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <label className="text-[10px] text-muted-foreground uppercase font-semibold">
                  项目名称
                </label>
                <input
                  type="text"
                  placeholder="例如: 我的创意脑图..."
                  value={newProjName}
                  onChange={(e) => setNewProjName(e.target.value)}
                  autoFocus
                  className="bg-secondary border border-white/5 rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary/80 transition-colors w-full"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setCreateModalOpen(false)}
                  className="px-3 py-1.5 rounded-lg bg-secondary hover:bg-secondary/80 font-semibold text-xs transition-colors cursor-pointer"
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="px-3 py-1.5 rounded-lg bg-primary hover:bg-primary/95 text-primary-foreground font-semibold text-xs transition-colors cursor-pointer"
                >
                  确认创建
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
