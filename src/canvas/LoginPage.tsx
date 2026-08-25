import { useCallback, useEffect, useRef, useState } from "react";
import { useConnectionStore, DEFAULT_SERVER_URL } from "@/store/connectionStore";
import { managedClient } from "@/services/managedClient";
import { Loader2, LogIn, UserPlus, KeyRound, RefreshCw } from "lucide-react";
import logoFull from "@/assets/brand/logo-full.png";

type Mode = "account" | "register" | "forgot";

/**
 * 登录页（P2 商业化改造：注册体系上线，激活码/机器码整体退役）：
 *  - 登录：账号（邮箱/手机号）+ 密码 → 解析出真凭证 accessKey 存本地；
 *  - 注册：邮箱/手机号 + 图形验证码 + 短信/邮件验证码 + 密码 + 可选邀请码
 *    （渠道商邀请码=归属该服务商；好友个人邀请码=记录邀请关系）；
 *  - 找回密码：验证码重置后回登录页。
 * 设备标识=随机 UUID（x-device-id 头，第218轮起无硬件语义）——服务端做「同时在线设备数」限制。
 */
export function LoginPage({ onLoggedIn }: { onLoggedIn: () => void }) {
	const serverUrl = useConnectionStore((s) => s.serverUrl);
	const storedAccount = useConnectionStore((s) => s.account);
	const setServerUrl = useConnectionStore((s) => s.setServerUrl);
	const setAccessKey = useConnectionStore((s) => s.setAccessKey);
	const setAccount = useConnectionStore((s) => s.setAccount);
	const setSession = useConnectionStore((s) => s.setSession);

	const [mode, setMode] = useState<Mode>("account");
	const [account, setAccountInput] = useState(storedAccount || "");
	const [password, setPassword] = useState("");
	const [displayName, setDisplayName] = useState("");
	const [code, setCode] = useState("");
	const [inviteCode, setInviteCode] = useState("");

	// 图形验证码（注册/找回发码前置）
	const [captcha, setCaptcha] = useState<{ id: string; svg: string } | null>(null);
	const [captchaAnswer, setCaptchaAnswer] = useState("");
	const [cooldown, setCooldown] = useState(0);
	const cooldownTimer = useRef<ReturnType<typeof setInterval> | null>(null);

	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	// 服务器地址栏默认隐藏（第225轮）：存量地址为空时补默认值一次（老安装升级后同样零配置）
	const [showServer, setShowServer] = useState(false);
	useEffect(() => {
		if (!useConnectionStore.getState().serverUrl.trim()) setServerUrl(DEFAULT_SERVER_URL);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const needsCaptcha = mode === "register" || mode === "forgot";

	const refreshCaptcha = useCallback(async () => {
		if (!serverUrl.trim()) return;
		setCaptchaAnswer("");
		const r = await managedClient.getCaptcha();
		if (r.ok && r.id && r.svg) setCaptcha({ id: r.id, svg: r.svg });
		else setCaptcha(null);
	}, [serverUrl]);

	useEffect(() => {
		if (needsCaptcha) void refreshCaptcha();
	}, [needsCaptcha, refreshCaptcha]);

	useEffect(() => () => { if (cooldownTimer.current) clearInterval(cooldownTimer.current); }, []);

	const startCooldown = (sec: number) => {
		setCooldown(sec);
		if (cooldownTimer.current) clearInterval(cooldownTimer.current);
		cooldownTimer.current = setInterval(() => {
			setCooldown((c) => {
				if (c <= 1) { if (cooldownTimer.current) clearInterval(cooldownTimer.current); return 0; }
				return c - 1;
			});
		}, 1000);
	};

	const switchMode = (m: Mode) => {
		setMode(m);
		setErr(null);
		setNotice(null);
		setCode("");
		setCaptchaAnswer("");
	};

	const finish = (r: { ok: boolean; accessKey?: string; user?: any; error?: string }, boundAccount?: string) => {
		if (r.ok) {
			if (r.accessKey) setAccessKey(r.accessKey);
			if (boundAccount) setAccount(boundAccount);
			setSession(true, r.user ?? null);
			onLoggedIn();
		} else {
			setSession(false, null);
			setErr(r.error ?? "操作失败");
		}
	};

	const sendCode = async () => {
		if (!serverUrl.trim()) { setErr("请填写服务器地址"); return; }
		if (!account.trim()) { setErr("请填写邮箱或手机号"); return; }
		if (!captcha || !captchaAnswer.trim()) { setErr("请填写图形验证码"); return; }
		setErr(null);
		const purpose = mode === "forgot" ? "reset" : "register";
		const r = await managedClient.sendVerifyCode(purpose, account.trim(), captcha.id, captchaAnswer.trim());
		if (r.ok) {
			setNotice(r.channel === "phone" ? "验证码已发送到手机，请查收短信" : "验证码已发送到邮箱，请查收（含垃圾箱）");
			startCooldown(60);
		} else {
			setErr(r.error ?? "发送失败");
			void refreshCaptcha(); // 图形码一次性：失败后必须换新
		}
	};

	const submit = async () => {
		if (!serverUrl.trim()) { setErr("请填写服务器地址"); return; }
		setErr(null);
		setNotice(null);

		if (mode === "account") {
			if (!account.trim() || !password) { setErr("请填写账号与密码"); return; }
			setBusy(true);
			const r = await managedClient.loginWithAccount(account.trim(), password);
			setBusy(false);
			finish(r, account.trim().toLowerCase());
			return;
		}

		if (mode === "register") {
			if (!account.trim()) { setErr("请填写邮箱或手机号"); return; }
			if (!code.trim()) { setErr("请填写验证码"); return; }
			if (password.length < 6) { setErr("密码至少 6 位"); return; }
			setBusy(true);
			const r = await managedClient.registerAccount(account.trim(), code.trim(), password, displayName.trim() || undefined, inviteCode.trim() || undefined);
			setBusy(false);
			finish(r, account.trim().toLowerCase());
			return;
		}

		// forgot
		if (!account.trim()) { setErr("请填写邮箱或手机号"); return; }
		if (!code.trim()) { setErr("请填写验证码"); return; }
		if (password.length < 6) { setErr("新密码至少 6 位"); return; }
		setBusy(true);
		const r = await managedClient.resetPassword(account.trim(), code.trim(), password);
		setBusy(false);
		if (r.ok) {
			switchMode("account");
			setPassword("");
			setNotice("密码已重置，请用新密码登录");
		} else {
			setErr(r.error ?? "重置失败");
		}
	};

	const tab = (m: Mode, label: string) => (
		<button
			onClick={() => switchMode(m)}
			className={`flex-1 py-1.5 text-[12px] rounded-md transition-colors cursor-pointer ${
				mode === m ? "bg-primary text-primary-foreground font-semibold" : "text-muted-foreground hover:text-foreground"
			}`}
		>
			{label}
		</button>
	);

	const inputCls =
		"w-full mb-3 bg-secondary/60 border border-border/40 rounded-lg px-3 py-2 text-[12px] font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary";

	const subtitle =
		mode === "register" ? "邮箱/手机号验证码注册，注册即登录。"
		: mode === "forgot" ? "验证邮箱/手机号后重置密码。"
		: "连接服务器，用账号 + 密码登录。";

	const isVerifyMode = mode === "register" || mode === "forgot";

	return (
		<div className="qiji-login-page fixed inset-0 flex items-center justify-center bg-[#0a0b0f] text-foreground">
			<div className="Qiji-panel w-[380px] rounded-2xl border border-white/10 p-7 shadow-2xl">
				<div className="flex justify-center mt-1 mb-3">
					{/* 第225轮：服务器地址栏默认隐藏（普通用户零配置直连默认服务器）；
					    双击 logo 展开——渠道商节点用户/运维改地址的隐蔽入口，勿删 */}
					<img
						src={logoFull}
						alt="Qiji"
						className="h-16 select-none"
						draggable={false}
						onDoubleClick={() => setShowServer((v) => !v)}
					/>
				</div>
				<p className="text-[11px] text-muted-foreground mb-4 text-center">{subtitle}</p>

				{showServer && (
					<>
						<label className="block text-[11px] text-muted-foreground mb-1">服务器地址</label>
						<input
							value={serverUrl}
							onChange={(e) => setServerUrl(e.target.value)}
							placeholder={DEFAULT_SERVER_URL}
							className={inputCls}
						/>
					</>
				)}

				{mode !== "forgot" && (
					<div className="flex gap-1 mb-4 bg-secondary/40 p-1 rounded-lg">
						{tab("account", "账号登录")}
						{tab("register", "注册")}
					</div>
				)}

				{mode === "register" && (
					<>
						<label className="block text-[11px] text-muted-foreground mb-1">用户名（昵称，可留空）</label>
						<input
							value={displayName}
							onChange={(e) => setDisplayName(e.target.value)}
							placeholder="显示名称，可用中文"
							className={inputCls}
						/>
					</>
				)}

				<label className="block text-[11px] text-muted-foreground mb-1">
					{mode === "account" ? "账号（邮箱 / 手机号）" : "邮箱 / 手机号"}
				</label>
				<input
					value={account}
					onChange={(e) => setAccountInput(e.target.value)}
					placeholder="you@example.com 或 13800000000"
					autoComplete="username"
					className={inputCls}
				/>

				{isVerifyMode && (
					<>
						<label className="block text-[11px] text-muted-foreground mb-1">图形验证码</label>
						<div className="flex gap-2 mb-3 items-center">
							<input
								value={captchaAnswer}
								onChange={(e) => setCaptchaAnswer(e.target.value)}
								placeholder="右图数字"
								className={inputCls + " flex-1 !mb-0"}
							/>
							{captcha ? (
								<img
									src={`data:image/svg+xml;utf8,${encodeURIComponent(captcha.svg)}`}
									alt="验证码"
									title="点击换一张"
									onClick={() => void refreshCaptcha()}
									className="h-9 rounded-md cursor-pointer select-none"
									draggable={false}
								/>
							) : (
								<button
									onClick={() => void refreshCaptcha()}
									className="h-9 px-2 text-[11px] text-muted-foreground border border-border/40 rounded-md cursor-pointer flex items-center gap-1"
								>
									<RefreshCw className="h-3 w-3" />
									获取
								</button>
							)}
						</div>
						<label className="block text-[11px] text-muted-foreground mb-1">验证码</label>
						<div className="flex gap-2 mb-3">
							<input
								value={code}
								onChange={(e) => setCode(e.target.value)}
								placeholder="6 位数字"
								className={inputCls + " flex-1 !mb-0"}
							/>
							<button
								onClick={() => void sendCode()}
								disabled={cooldown > 0}
								className="shrink-0 px-3 text-[11px] rounded-lg border border-border/40 text-foreground hover:border-primary disabled:opacity-50 cursor-pointer"
							>
								{cooldown > 0 ? `${cooldown}s 后重发` : "获取验证码"}
							</button>
						</div>
					</>
				)}

				<label className="block text-[11px] text-muted-foreground mb-1">{mode === "forgot" ? "新密码" : "密码"}</label>
				<input
					type="password"
					value={password}
					onChange={(e) => setPassword(e.target.value)}
					onKeyDown={(e) => e.key === "Enter" && mode === "account" && submit()}
					placeholder={mode === "account" ? "密码" : "至少 6 位"}
					autoComplete={mode === "account" ? "current-password" : "new-password"}
					className={inputCls}
				/>

				{mode === "register" && (
					<>
						<label className="block text-[11px] text-muted-foreground mb-1">邀请码（可选）</label>
						<input
							value={inviteCode}
							onChange={(e) => setInviteCode(e.target.value)}
							onKeyDown={(e) => e.key === "Enter" && submit()}
							placeholder="服务商或好友的邀请码，可留空"
							className={inputCls}
						/>
					</>
				)}

				{err && <p className="text-[11px] text-destructive mb-3">{err}</p>}
				{notice && <p className="text-[11px] text-emerald-400 mb-3">{notice}</p>}

				<button
					onClick={submit}
					disabled={busy}
					className="w-full flex items-center justify-center gap-2 bg-primary text-primary-foreground font-semibold rounded-lg py-2.5 text-[13px] hover:bg-primary/90 transition-colors disabled:opacity-60 cursor-pointer"
				>
					{busy ? (
						<Loader2 className="h-4 w-4 animate-spin" />
					) : mode === "account" ? (
						<LogIn className="h-4 w-4" />
					) : mode === "forgot" ? (
						<KeyRound className="h-4 w-4" />
					) : (
						<UserPlus className="h-4 w-4" />
					)}
					{busy ? "处理中…" : mode === "account" ? "登录" : mode === "forgot" ? "重置密码" : "注册并登录"}
				</button>

				<div className="flex justify-between mt-3 text-[11px] text-muted-foreground">
					{mode === "account" && (
						<>
							<button className="hover:text-foreground cursor-pointer" onClick={() => switchMode("forgot")}>忘记密码？</button>
							<span />
						</>
					)}
					{mode === "forgot" && (
						<>
							<button className="hover:text-foreground cursor-pointer" onClick={() => switchMode("account")}>← 返回登录</button>
							<span />
						</>
					)}
				</div>

				{mode === "register" && (
					<p className="mt-3 text-[10px] text-muted-foreground/70 text-center">
						注册即表示同意《用户协议》与《隐私政策》
					</p>
				)}
			</div>
		</div>
	);
}
