/**
 * TitleBar.tsx — 自定义标题栏组件
 *
 * 显示：项目名 + 脏标记（●）+ 保存状态 + Tauri 窗口控制按钮
 * 在 Tauri 环境下使用无边框窗口 + 自定义标题栏，
 * 浏览器环境下隐藏窗口控制按钮。
 */
import { useState, useRef, useEffect, useMemo } from "react";
import { useProjectStore } from "@/store/projectStore";
import { useCommitStore } from "@/store/commitStore";

import { Minus, Square, X, Circle, History, Home, ArrowLeft } from "lucide-react";
import { useLocation, useNavigate } from "react-router";

function isTauri(): boolean {
  return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

async function tauriWindow() {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

export function TitleBar() {
  const name    = useProjectStore((s) => s.name);
  const isDirty = useProjectStore((s) => s.isDirty);
  const isSaving = useProjectStore((s) => s.isSaving);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const [historyMenuOpen, setHistoryMenuOpen] = useState(false);
  const historyRef = useRef<HTMLDivElement>(null);

  const head = useCommitStore((s) => s.head);
  const commits = useCommitStore((s) => s.commits);

  const location = useLocation();
  const navigate = useNavigate();
  const isWorkspace = location.pathname !== "/" && location.pathname !== "/frame164";
  const isCanvas = location.pathname === "/frame-canvas";
  const isStoryboard = location.pathname === "/frame-storyboard";

  const sortedCommits = useMemo(() => {
    return Object.values(commits).sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }, [commits]);

  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
      if (historyRef.current && !historyRef.current.contains(e.target as Node)) {
        setHistoryMenuOpen(false);
      }
    };
    if (menuOpen || historyMenuOpen) {
      document.addEventListener("mousedown", handleOutsideClick);
    }
    return () => {
      document.removeEventListener("mousedown", handleOutsideClick);
    };
  }, [menuOpen, historyMenuOpen]);

  const handleMinimize = async () => {
    try {
      const win = await tauriWindow();
      await win.minimize();
    } catch (e: any) {
      alert("最小化失败:\n" + (e?.message || JSON.stringify(e)));
    }
  };

  const handleMaximize = async () => {
    try {
      const win = await tauriWindow();
      await win.toggleMaximize();
    } catch (e: any) {
      alert("最大化失败:\n" + (e?.message || JSON.stringify(e)));
    }
  };

  const handleClose = async () => {
    try {
      const win = await tauriWindow();
      const dirty = useProjectStore.getState().isDirty;
      if (dirty) {
        const { ask } = await import("@tauri-apps/plugin-dialog");
        const yes = await ask("有未保存的更改，是否保存后退出？", {
          title: "Qiji",
          kind: "warning",
          okLabel: "保存并退出",
          cancelLabel: "放弃更改",
        });
        if (yes) {
          await useProjectStore.getState().save();
        }
      }
      await win.close();
    } catch (e: any) {
      alert("关闭窗口失败:\n" + (e?.message || JSON.stringify(e)));
    }
  };

  return (
    <div className="Qiji-titlebar">
      {/* 拖拽感应底面，绝对定位以覆盖整个标题栏背景 */}
      <div 
        className="Qiji-titlebar__drag-bg" 
        data-tauri-drag-region 
      />

      <div className="Qiji-titlebar__left">
        <span className="Qiji-titlebar__logo">Qiji</span>
        
        {isWorkspace && (
          <>
            {(isCanvas || isStoryboard) && (
              <button
                onClick={() => navigate("/frame1693")}
                className="flex items-center gap-1 px-1.5 py-0.5 ml-3 rounded text-[10px] text-primary hover:text-primary-foreground hover:bg-primary/20 transition-all cursor-pointer border border-primary/20 active:scale-95"
                title="返回配置编辑器"
              >
                <ArrowLeft className="h-3 w-3" />
                <span>返回配置</span>
              </button>
            )}
            <button
              onClick={() => navigate("/")}
              className="flex items-center gap-1 px-1.5 py-0.5 ml-3 rounded text-[10px] text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-all cursor-pointer border border-white/5 active:scale-95"
              title="返回项目大厅"
            >
              <Home className="h-3 w-3" />
              <span>项目大厅</span>
            </button>
        
        {/* 顶部文件菜单 */}
        <div className="Qiji-titlebar__menu-container" ref={menuRef}>
          <button
            className={`Qiji-titlebar__menu-trigger ${menuOpen ? "is-active" : ""}`}
            onClick={() => setMenuOpen(!menuOpen)}
          >
            文件
          </button>
          {menuOpen && (
            <div className="Qiji-titlebar__dropdown">
              <button
                className="Qiji-titlebar__dropdown-item"
                onClick={() => { setMenuOpen(false); useProjectStore.getState().newProject(); }}
              >
                <span>新建项目</span>
                <span className="Qiji-titlebar__dropdown-shortcut">Ctrl+N</span>
              </button>
              <button
                className="Qiji-titlebar__dropdown-item"
                onClick={() => { setMenuOpen(false); useProjectStore.getState().open(); }}
              >
                <span>打开项目...</span>
                <span className="Qiji-titlebar__dropdown-shortcut">Ctrl+O</span>
              </button>
              {isTauri() && (
                <>
                  <div className="Qiji-titlebar__dropdown-divider" />
                  <button
                    className="Qiji-titlebar__dropdown-item"
                    onClick={() => { setMenuOpen(false); useProjectStore.getState().importProject(); }}
                  >
                    <span>导入项目 (.zip)...</span>
                  </button>
                  <button
                    className="Qiji-titlebar__dropdown-item"
                    disabled={!useProjectStore.getState().savePath}
                    onClick={() => { setMenuOpen(false); useProjectStore.getState().exportProject(); }}
                  >
                    <span>导出项目 (.zip)...</span>
                  </button>
                </>
              )}
              <div className="Qiji-titlebar__dropdown-divider" />
              <button
                className="Qiji-titlebar__dropdown-item"
                onClick={() => { setMenuOpen(false); useProjectStore.getState().save(); }}
              >
                <span>保存</span>
                <span className="Qiji-titlebar__dropdown-shortcut">Ctrl+S</span>
              </button>
              <button
                className="Qiji-titlebar__dropdown-item"
                onClick={() => { setMenuOpen(false); useProjectStore.getState().saveAs(); }}
              >
                <span>另存为...</span>
                <span className="Qiji-titlebar__dropdown-shortcut">Ctrl+Shift+S</span>
              </button>
              {isTauri() && (
                <>
                  <div className="Qiji-titlebar__dropdown-divider" />
                  <button
                    className="Qiji-titlebar__dropdown-item Qiji-titlebar__dropdown-item--danger"
                    onClick={() => { setMenuOpen(false); handleClose(); }}
                  >
                    <span>退出</span>
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        <span className="Qiji-titlebar__sep">·</span>
        <span className="Qiji-titlebar__project">
          {isDirty && !isSaving && (
            <Circle className="h-1.5 w-1.5 fill-current text-amber-400 mr-1.5 inline" />
          )}
          {isSaving ? "保存中…" : name}
        </span>

        <span className="Qiji-titlebar__sep">·</span>

        {/* 历史提交纪录 */}
        <div className="Qiji-titlebar__history-container" ref={historyRef}>
          <button
            className={`Qiji-titlebar__history-trigger ${historyMenuOpen ? "is-active" : ""}`}
            onClick={() => {
              setHistoryMenuOpen(!historyMenuOpen);
              setMenuOpen(false);
            }}
          >
            <History className="h-3.5 w-3.5 mr-1.5 inline text-primary" />
            提交历史
          </button>
          
          {historyMenuOpen && (
            <div className="Qiji-titlebar__dropdown w-72 max-h-80 overflow-y-auto Qiji-scroll-thin">
              <div className="px-2 py-1 text-muted-foreground font-semibold text-[9px] uppercase border-b border-border/40 mb-1 select-none">
                提交快照历史 (点击回滚)
              </div>
              {sortedCommits.map((c) => {
                const isActive = head === c.commitId;
                return (
                  <button
                    key={c.commitId}
                    className={`Qiji-titlebar__dropdown-item flex flex-col items-start gap-0.5 py-1.5 ${isActive ? "bg-primary/10 border-l-2 border-primary" : ""}`}
                    onClick={() => {
                      setHistoryMenuOpen(false);
                      useCommitStore.getState().checkoutCommit(c.commitId);
                    }}
                  >
                    <div className="flex w-full justify-between items-center text-[11px]">
                      <span className={`font-semibold ${isActive ? "text-primary" : "text-foreground"}`}>
                        {c.message}
                      </span>
                      <span className="font-mono text-[9px] text-muted-foreground">
                        {c.commitId.slice(0, 7)}
                      </span>
                    </div>
                    <span className="text-[9px] text-muted-foreground">
                      {new Date(c.timestamp).toLocaleString("zh-CN")} · {c.author}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
          </>
        )}
      </div>

      {/* 窗口控制（仅 Tauri 显示） */}
      {isTauri() && (
        <div className="Qiji-titlebar__controls">
          <button
            onClick={handleMinimize}
            className="Qiji-titlebar__btn"
            aria-label="最小化"
          >
            <Minus className="h-3 w-3" />
          </button>
          <button
            onClick={handleMaximize}
            className="Qiji-titlebar__btn"
            aria-label="最大化"
          >
            <Square className="h-3 w-3" />
          </button>
          <button
            onClick={handleClose}
            className="Qiji-titlebar__btn Qiji-titlebar__btn--close"
            aria-label="关闭"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}
    </div>
  );
}

