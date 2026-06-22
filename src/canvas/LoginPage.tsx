import { useState } from "react";
import { useConnectionStore, getMachineCode } from "@/store/connectionStore";
import { managedClient } from "@/services/managedClient";
import { Server, Loader2, LogIn } from "lucide-react";

/**
 * 登录页：填管理端服务器地址 + accessKey，校验通过才进入应用。
 * 未登录不可用（App 根据 connectionStore.loggedIn 门禁）。
 */
export function LoginPage({ onLoggedIn }: { onLoggedIn: () => void }) {
	const serverUrl = useConnectionStore((s) => s.serverUrl);
	const accessKey = useConnectionStore((s) => s.accessKey);
	const setServerUrl = useConnectionStore((s) => s.setServerUrl);
	const setAccessKey = useConnectionStore((s) => s.setAccessKey);
	const setSession = useConnectionStore((s) => s.setSession);

	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | null>(null);
	const machineCode = getMachineCode();

	const handleLogin = async () => {
		if (!serverUrl.trim() || !accessKey.trim()) {
			setErr("请填写服务器地址与 accessKey");
			return;
		}
		setBusy(true);
		setErr(null);
		const r = await managedClient.login();
		setBusy(false);
		if (r.ok) {
			setSession(true, r.user ?? null);
			onLoggedIn();
		} else {
			setSession(false, null);
			setErr(r.error ?? "登录失败");
		}
	};

	return (
		<div className="qiji-login-page fixed inset-0 flex items-center justify-center bg-[#0a0b0f] text-foreground">
			<div className="Qiji-panel w-[380px] rounded-2xl border border-white/10 p-7 shadow-2xl">
				<div className="flex items-center gap-2 mb-1">
					<Server className="h-5 w-5 text-primary" />
					<h1 className="text-base font-semibold">登录 Qiji</h1>
				</div>
				<p className="text-[11px] text-muted-foreground mb-5">
					连接管理端：输入服务器地址与管理员分配的 accessKey。
				</p>

				<label className="block text-[11px] text-muted-foreground mb-1">服务器地址</label>
				<input
					value={serverUrl}
					onChange={(e) => setServerUrl(e.target.value)}
					placeholder="http://localhost:8787"
					className="w-full mb-3 bg-secondary/60 border border-border/40 rounded-lg px-3 py-2 text-[12px] font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary"
				/>

				<label className="block text-[11px] text-muted-foreground mb-1">accessKey</label>
				<input
					type="password"
					value={accessKey}
					onChange={(e) => setAccessKey(e.target.value)}
					onKeyDown={(e) => e.key === "Enter" && handleLogin()}
					placeholder="qk-..."
					className="w-full mb-4 bg-secondary/60 border border-border/40 rounded-lg px-3 py-2 text-[12px] font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary"
				/>

				{err && <p className="text-[11px] text-destructive mb-3">{err}</p>}

				<div className="mb-4 text-[10px] text-muted-foreground">
					<div className="mb-1">本机机器码（首次登录将绑定到该账号，换机需管理员解绑）</div>
					<div
						className="font-mono text-[10px] break-all bg-secondary/40 border border-border/30 rounded px-2 py-1 cursor-pointer hover:border-primary/50"
						title="点击复制"
						onClick={() => navigator.clipboard?.writeText(machineCode)}
					>
						{machineCode}
					</div>
				</div>

				<button
					onClick={handleLogin}
					disabled={busy}
					className="w-full flex items-center justify-center gap-2 bg-primary text-primary-foreground font-semibold rounded-lg py-2.5 text-[13px] hover:bg-primary/90 transition-colors disabled:opacity-60 cursor-pointer"
				>
					{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
					{busy ? "登录中…" : "登录"}
				</button>
			</div>
		</div>
	);
}
