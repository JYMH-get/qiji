import React, { useState, useEffect } from "react";
import { getMachineId, activateClient } from "@/services/auth";
import { KeyRound, Cpu, Loader2, Sparkles, CheckCircle2 } from "lucide-react";

interface ActivationOverlayProps {
  onActivated: () => void;
}

export function ActivationOverlay({ onActivated }: ActivationOverlayProps) {
  const [code, setCode] = useState("");
  const [machineId, setMachineId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    getMachineId().then(setMachineId);
  }, []);

  const handleActivate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim()) return;

    setLoading(true);
    setError(null);
    try {
      const res = await activateClient(code);
      if (res.success) {
        setSuccess(true);
        setTimeout(() => {
          onActivated();
        }, 1500);
      } else {
        setError(res.error || "激活失败，请检查您的激活码是否正确");
      }
    } catch (err: any) {
      setError("网络错误，无法连接到授权服务器");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[30000] flex items-center justify-center bg-[#0a0b0f]/90 backdrop-blur-xl">
      <div 
        className="relative w-full max-w-md p-8 rounded-2xl border border-white/[0.08] bg-[#12141a]/65 shadow-2xl text-center"
        style={{
          boxShadow: "0 20px 50px rgba(0, 0, 0, 0.5), 0 0 40px rgba(91, 141, 246, 0.05)"
        }}
      >
        {/* Glow Effects */}
        <div className="absolute -top-10 -left-10 w-40 h-40 bg-blue-500/10 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute -bottom-10 -right-10 w-40 h-40 bg-purple-500/10 rounded-full blur-3xl pointer-events-none" />

        <div className="mb-6 flex justify-center">
          <div className="p-4 rounded-full bg-blue-500/10 border border-blue-500/20 text-[#5b8df6] animate-pulse">
            <Sparkles className="w-10 h-10" />
          </div>
        </div>

        <h2 className="text-2xl font-bold text-white mb-2 tracking-wide">Qiji 智能创作画布</h2>
        <p className="text-[#98a2b3] text-sm mb-8">本设备尚未激活，请输入激活码完成绑定</p>

        {success ? (
          <div className="py-6 flex flex-col items-center gap-3">
            <CheckCircle2 className="w-12 h-12 text-[#56cfb2]" />
            <p className="text-[#56cfb2] font-semibold text-lg">激活成功！</p>
            <p className="text-sm text-gray-400">正在为您载入画布主界面...</p>
          </div>
        ) : (
          <form onSubmit={handleActivate} className="text-left">
            <div className="mb-5">
              <label className="block text-xs font-semibold text-[#98a2b3] uppercase tracking-wider mb-2 flex items-center gap-1.5">
                <KeyRound className="w-3.5 h-3.5" /> 激活码 (Activation Code)
              </label>
              <input
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="如: AC-TEST8888"
                className="w-full bg-black/40 border border-white/[0.08] text-white px-4 py-3 rounded-lg focus:outline-none focus:border-[#5b8df6] focus:ring-2 focus:ring-[#5b8df6]/20 transition-all font-mono placeholder:text-gray-600"
                disabled={loading}
              />
            </div>

            {error && (
              <div className="mb-5 p-3 rounded-lg bg-red-500/10 border border-red-500/25 text-[#f06b6b] text-sm">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading || !code.trim()}
              className="w-full py-3 px-4 bg-[#5b8df6] hover:bg-[#4a7ee0] text-[#0a0b0f] font-bold rounded-lg transition-all shadow-lg shadow-blue-500/15 active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none flex items-center justify-center gap-2"
            >
              {loading ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  正在校验激活码...
                </>
              ) : (
                "激活并绑定本设备"
              )}
            </button>
          </form>
        )}

        <div className="mt-8 pt-6 border-t border-white/[0.05] flex items-center justify-between text-xs text-[#98a2b3]">
          <span className="flex items-center gap-1">
            <Cpu className="w-3.5 h-3.5" /> 机器识别码 (UUID)
          </span>
          <span 
            className="font-mono bg-white/[0.03] px-2 py-1 rounded border border-white/[0.05] select-all cursor-pointer hover:bg-white/[0.05]"
            title="点击复制"
            onClick={() => {
              navigator.clipboard.writeText(machineId);
              alert("机器识别码已复制到剪贴板");
            }}
          >
            {machineId || "正在读取..."}
          </span>
        </div>
      </div>
    </div>
  );
}
