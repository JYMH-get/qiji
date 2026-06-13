import { useState } from "react";
import { useUiStore } from "@/store/uiStore";
import { LogIn, Key, User, ShieldAlert } from "lucide-react";

export function LoginPage() {
  const setCurrentUser = useUiStore((s) => s.setCurrentUser);
  const setScreen = useUiStore((s) => s.setScreen);

  const [username, setUsername] = useState(() => localStorage.getItem("Qiji:lastLoggedInUser") || "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim()) {
      setError("请输入用户名");
      return;
    }
    if (!password.trim()) {
      setError("请输入密码");
      return;
    }

    setLoading(true);
    setError("");

    // 模拟登录延迟，优化体验
    setTimeout(() => {
      setLoading(false);
      localStorage.setItem("Qiji:lastLoggedInUser", username.trim());
      setCurrentUser(username.trim());
      setScreen("dashboard");
    }, 850);
  };

  const handleGuestLogin = () => {
    setLoading(true);
    setTimeout(() => {
      setLoading(false);
      localStorage.setItem("Qiji:lastLoggedInUser", "访客用户");
      setCurrentUser("访客用户");
      setScreen("dashboard");
    }, 500);
  };

  return (
    <div className="relative w-full h-full min-h-screen bg-[#07080a] flex items-center justify-center p-4 overflow-hidden select-none pt-8">
      {/* 渐变流光背景 */}
      <div className="absolute top-1/4 left-1/4 w-[400px] h-[400px] bg-primary/10 rounded-full blur-[120px] pointer-events-none animate-pulse-slow" />
      <div className="absolute bottom-1/4 right-1/4 w-[350px] h-[350px] bg-purple-500/10 rounded-full blur-[100px] pointer-events-none" />

      {/* 登录主体卡片 */}
      <div className="relative w-full max-w-[400px] bg-card/60 backdrop-blur-xl border border-white/10 rounded-2xl p-8 shadow-2xl flex flex-col items-center">
        {/* Logo 和 标题 */}
        <div className="flex flex-col items-center gap-2 mb-8 text-center">
          <div className="h-12 w-12 rounded-xl bg-gradient-to-tr from-primary to-purple-500 flex items-center justify-center text-primary-foreground font-black text-xl shadow-lg shadow-primary/25">
            Q
          </div>
          <h1 className="text-xl font-bold text-foreground tracking-wide mt-2">
            欢迎来到 Qiji 工作台
          </h1>
          <p className="text-xs text-muted-foreground">
            一个现代化智能无限画布创作系统
          </p>
        </div>

        {/* 登录表单 */}
        <form onSubmit={handleLogin} className="w-full flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-[10px] uppercase font-semibold text-muted-foreground tracking-wider">
              用户名 / 账号
            </label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                <User className="h-4 w-4" />
              </span>
              <input
                type="text"
                placeholder="输入用户名..."
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                disabled={loading}
                className="w-full bg-secondary/50 border border-white/5 focus:border-primary/80 focus:ring-1 focus:ring-primary/45 rounded-lg pl-9 pr-4 py-2 text-sm text-foreground placeholder-muted-foreground outline-none transition-all duration-200"
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-[10px] uppercase font-semibold text-muted-foreground tracking-wider">
              密码
            </label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                <Key className="h-4 w-4" />
              </span>
              <input
                type="password"
                placeholder="输入密码..."
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={loading}
                className="w-full bg-secondary/50 border border-white/5 focus:border-primary/80 focus:ring-1 focus:ring-primary/45 rounded-lg pl-9 pr-4 py-2 text-sm text-foreground placeholder-muted-foreground outline-none transition-all duration-200"
              />
            </div>
          </div>

          {/* 错误提示 */}
          {error && (
            <div className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-xs">
              <ShieldAlert className="h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* 登录按钮 */}
          <button
            type="submit"
            disabled={loading}
            className="w-full h-9 mt-2 flex items-center justify-center gap-2 rounded-lg bg-primary font-bold text-sm text-primary-foreground hover:bg-primary/90 active:scale-[0.98] transition-all cursor-pointer disabled:opacity-50 disabled:pointer-events-none"
          >
            {loading ? (
              <div className="h-4 w-4 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
            ) : (
              <>
                <LogIn className="h-4 w-4" />
                <span>立即登录</span>
              </>
            )}
          </button>
        </form>

        {/* 辅助线 */}
        <div className="flex items-center w-full my-6">
          <div className="flex-1 h-[1px] bg-white/5" />
          <span className="px-3 text-[10px] uppercase font-semibold text-muted-foreground tracking-wider">
            或者
          </span>
          <div className="flex-1 h-[1px] bg-white/5" />
        </div>

        {/* 游客通道 */}
        <button
          onClick={handleGuestLogin}
          disabled={loading}
          className="w-full h-9 border border-white/10 hover:border-white/20 rounded-lg font-semibold text-xs text-muted-foreground hover:text-foreground hover:bg-secondary/35 active:scale-[0.98] transition-all cursor-pointer disabled:opacity-50 disabled:pointer-events-none"
        >
          以访客身份继续访问
        </button>

        {/* 页脚说明 */}
        <div className="mt-8 text-[10px] text-muted-foreground/60 text-center leading-normal">
          Tauri Native Web Environment · Secure Client Sandbox
        </div>
      </div>
    </div>
  );
}
