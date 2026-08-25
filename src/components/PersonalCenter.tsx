import { useEffect, useRef, useState } from "react";
import { X, UserCircle, Coins, Gift, Loader2, CheckCircle, XCircle, RefreshCw, Clapperboard, Film, Server, LogOut, ListOrdered, ChevronDown, ChevronRight, Undo2, Users, BarChart3, KeyRound, Download, Crown, Sparkles } from "lucide-react";
import { useUiStore } from "@/store/uiStore";
import { useComfyuiStore } from "@/store/comfyuiStore";
import { thirdPartyFeeCredits } from "@/services/thirdPartyFee";
import { useConnectionStore, useComfyuiFeature, useDreaminaFeature, useLibtvFeature } from "@/store/connectionStore";
import { useProjectStore } from "@/store/projectStore";
import { confirmDialog } from "@/lib/confirmDialog";
import { useLibtvStore } from "@/store/libtvStore";
import { useDreaminaStore } from "@/store/dreaminaStore";
import { managedClient } from "@/services/managedClient";
import { versionLabel } from "@/lib/appVersion";
import { formatDurationWithQueue } from "@/lib/queueLabel";
import type { UserStats, UserLogItem, UserLogDetail, TeamDetail, TeamInviteInfo, UserConsumeStats, ConsumeRangeStats, DownloadManifest, DownloadLinkStorage, DownloadMediaKind } from "@/contract";
import { runBatchDownload, fmtBytes, type BatchDownloadProgress, type BatchDownloadResult } from "@/services/batchDownload";
import { RechargeCenter, discountLabel } from "@/components/RechargeCenter";

const isTauri = (): boolean =>
	typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

/**
 * 个人中心：查看积分余额 / 消耗统计 + 兑换积分码 + LibTV 授权。
 * 数据来自管理端 /v1/me（积分、当日/累计消耗）；兑换走 /v1/redeem；
 * LibTV 授权走随包内置 CLI（凭据只在本机，生成不扣 Qiji 积分）。
 */

/** LibTV 授权区块：连接（浏览器登录回跳）/ 状态 / 退出。仅桌面端 + features.libtv 开时渲染。 */
function LibtvSection() {
	const st = useLibtvStore();

	// 打开个人中心即刷新一次授权状态（登录/换号在浏览器侧发生，本机只能查询感知）
	useEffect(() => {
		void useLibtvStore.getState().refresh();
	}, []);

	const handleConnect = async () => {
		await st.loginWeb(); // 内部阻塞至浏览器回跳/超时，结束后自动刷新状态
	};

	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
				<Clapperboard className="h-3.5 w-3.5 text-primary" /> LibTV 授权
				<span className="text-[9px] font-normal text-muted-foreground">（Seedance 2.0 视频生成 · 走你自己的 LibTV 账号，不扣积分）</span>
			</div>
			<div className="flex items-center justify-between bg-secondary/30 border border-border/30 rounded-lg px-4 py-3">
				{st.checking && !st.checked ? (
					<span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
						<Loader2 className="h-3.5 w-3.5 animate-spin" /> 正在检测授权状态…
					</span>
				) : st.authed ? (
					<>
						<span className="flex items-center gap-1.5 text-[11px] text-foreground flex-wrap">
							<CheckCircle className="h-3.5 w-3.5 text-green-400" />
							已连接：{st.nickname}
							{st.accountName && st.accountName !== st.nickname ? <span className="text-muted-foreground">（{st.accountName}）</span> : null}
							{st.memberName ? (
								<span className="px-1.5 py-0.5 rounded bg-primary/15 border border-primary/30 text-primary text-[9px] whitespace-nowrap">{st.memberName}</span>
							) : null}
						</span>
						<button
							onClick={() => void st.logout()}
							className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-secondary text-foreground hover:bg-secondary/70 transition-colors cursor-pointer text-[10px]"
						>
							<LogOut className="h-3 w-3" /> 退出登录
						</button>
					</>
				) : (
					<>
						<span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
							{st.loggingIn ? (
								<>
									<Loader2 className="h-3.5 w-3.5 animate-spin" /> 等待浏览器登录回跳…（5 分钟内有效）
								</>
							) : (
								<>
									<XCircle className="h-3.5 w-3.5 text-muted-foreground" /> 未连接
								</>
							)}
						</span>
						<button
							onClick={handleConnect}
							disabled={st.loggingIn}
							className="px-4 py-1.5 rounded-lg bg-primary text-primary-foreground font-semibold hover:bg-primary/90 transition-colors cursor-pointer text-[10px] disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
						>
							连接 LibTV
						</button>
					</>
				)}
			</div>
			{st.loginError && (
				<span className="flex items-center gap-1 text-[10px] text-destructive">
					<XCircle className="h-3 w-3" /> {st.loginError}
				</span>
			)}
			{st.authed && (
				<span className="text-[10px] text-muted-foreground">
					已连接后，视频生成的模型下拉会出现「LibTV · Seedance 2.0」。积分请到 LibTV 网页端查看（CLI 暂未提供积分接口，此处显示会员套餐）。
				</span>
			)}
		</div>
	);
}
/** 即梦（Dreamina）授权区块：OAuth 设备码登录 / 状态（即梦积分）/ 退出。仅桌面端 + features.dreamina 开时渲染。
 *  凭据在用户全局 ~/.dreamina_cli（终端 `curl -s https://jimeng.jianying.com/cli | bash` 装过并登录的直接复用）。 */
function DreaminaSection() {
	const st = useDreaminaStore();

	// 打开个人中心即刷新一次授权状态（登录/换号可能在终端侧发生，本机只能查询感知）
	useEffect(() => {
		void useDreaminaStore.getState().refresh();
	}, []);

	const handleConnect = async () => {
		await st.loginDeviceFlow(); // 内部阻塞至浏览器授权/超时，结束后自动刷新状态
	};

	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
				<Film className="h-3.5 w-3.5 text-primary" /> 即梦授权
				<span className="text-[9px] font-normal text-muted-foreground">（Seedance 2.0 视频生成 · 走你自己的即梦账号，不扣 Qiji 积分）</span>
			</div>
			<div className="flex items-center justify-between bg-secondary/30 border border-border/30 rounded-lg px-4 py-3">
				{st.checking && !st.checked ? (
					<span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
						<Loader2 className="h-3.5 w-3.5 animate-spin" /> 正在检测授权状态…
					</span>
				) : st.authed ? (
					<>
						<span className="flex items-center gap-1.5 text-[11px] text-foreground flex-wrap">
							<CheckCircle className="h-3.5 w-3.5 text-green-400" />
							已连接：即梦用户 {st.userId}
							<span className="px-1.5 py-0.5 rounded bg-primary/15 border border-primary/30 text-primary text-[9px] whitespace-nowrap">
								即梦积分 {st.totalCredit.toLocaleString()}
							</span>
							{st.vipLevel ? (
								<span className="px-1.5 py-0.5 rounded bg-primary/15 border border-primary/30 text-primary text-[9px] whitespace-nowrap">{st.vipLevel}</span>
							) : null}
						</span>
						<button
							onClick={() => void st.logout()}
							className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-secondary text-foreground hover:bg-secondary/70 transition-colors cursor-pointer text-[10px]"
						>
							<LogOut className="h-3 w-3" /> 退出登录
						</button>
					</>
				) : (
					<>
						<span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
							{st.loggingIn ? (
								<span className="flex flex-col gap-0.5">
									<span className="flex items-center gap-1.5">
										<Loader2 className="h-3.5 w-3.5 animate-spin" /> 等待浏览器授权…（5 分钟内有效）
									</span>
									{st.pendingUserCode && (
										<span className="text-[10px]">
											配对码 <span className="font-mono text-foreground">{st.pendingUserCode}</span>
											（浏览器没自动打开时手动访问：<span className="font-mono break-all">{st.pendingVerificationUri}</span>）
										</span>
									)}
								</span>
							) : (
								<>
									<XCircle className="h-3.5 w-3.5 text-muted-foreground" /> 未连接
								</>
							)}
						</span>
						<button
							onClick={handleConnect}
							disabled={st.loggingIn}
							className="px-4 py-1.5 rounded-lg bg-primary text-primary-foreground font-semibold hover:bg-primary/90 transition-colors cursor-pointer text-[10px] disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
						>
							连接即梦
						</button>
					</>
				)}
			</div>
			{st.loginError && (
				<span className="flex items-center gap-1 text-[10px] text-destructive">
					<XCircle className="h-3 w-3" /> {st.loginError}
				</span>
			)}
			{st.authed && (
				<span className="text-[10px] text-muted-foreground">
					已连接后，视频生成的模型下拉会出现「即梦 · Seedance 2.0」（全能参考，需至少一张垫图或参考视频；消耗即梦积分）。
				</span>
			)}
		</div>
	);
}

/** ComfyUI 直连绑定区块（多端点）：端点列表（测试/启停/删除）+ 新增行。features.comfyui 开时渲染
 *（不限桌面端——浏览器 dev 需 ComfyUI 带 --enable-cors-header 启动，区块内有提示）。
 *  可绑定多台：提交时自动探测各台队列负载，派给最闲的一台（平手轮流）。 */
function ComfyuiSection() {
	const endpoints = useComfyuiStore((s) => s.endpoints);
	const probes = useComfyuiStore((s) => s.probes);
	const testing = useComfyuiStore((s) => s.testing);
	const [addUrl, setAddUrl] = useState("");
	const [addName, setAddName] = useState("");
	const [addMsg, setAddMsg] = useState("");

	const handleAdd = async () => {
		const r = useComfyuiStore.getState().addEndpoint(addUrl, addName);
		if (!r.ok) {
			setAddMsg(r.error || "添加失败");
			return;
		}
		setAddUrl("");
		setAddName("");
		setAddMsg("");
		// 添加即顺手测一把连通性（结果在行内展示）
		const added = useComfyuiStore.getState().endpoints;
		const last = added[added.length - 1];
		if (last) void useComfyuiStore.getState().testEndpoint(last.id);
	};

	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
				<Server className="h-3.5 w-3.5 text-primary" /> ComfyUI 直连
				<span className="text-[9px] font-normal text-muted-foreground">
					（MiniMax H3 视频生成 · 走你自己的 ComfyUI 实例，可绑定多台自动分流）
				</span>
			</div>

			{/* 已绑定端点列表 */}
			{endpoints.map((ep) => {
				const probe = probes[ep.id];
				const busy = !!testing[ep.id];
				return (
					<div key={ep.id} className={`flex items-center gap-2 rounded-lg border border-border/40 px-2.5 py-1.5 ${ep.enabled ? "bg-secondary/30" : "bg-secondary/10 opacity-60"}`}>
						<button
							onClick={() => useComfyuiStore.getState().updateEndpoint(ep.id, { enabled: !ep.enabled })}
							title={ep.enabled ? "点击停用（不参与自动分流）" : "点击启用"}
							className={`h-3 w-3 rounded-full shrink-0 cursor-pointer border ${ep.enabled ? "bg-green-400/80 border-green-400" : "bg-transparent border-muted-foreground/50"}`}
						/>
						<div className="flex flex-col min-w-0 flex-1">
							<span className="text-[11px] text-foreground truncate">{ep.name}</span>
							<span className="text-[9px] font-mono text-muted-foreground truncate">{ep.url}</span>
						</div>
						{probe?.state === "ok" && (
							<span className="flex items-center gap-1 text-[9px] text-green-400 whitespace-nowrap" title="最近一次测试连通">
								<CheckCircle className="h-3 w-3" /> 已连通{typeof probe.load === "number" ? ` · 队列 ${probe.load}` : ""}
							</span>
						)}
						{probe?.state === "fail" && (
							<span className="flex items-center gap-1 text-[9px] text-destructive max-w-[180px] truncate" title={probe.error}>
								<XCircle className="h-3 w-3 shrink-0" /> {probe.error || "连接失败"}
							</span>
						)}
						<button
							onClick={() => void useComfyuiStore.getState().testEndpoint(ep.id)}
							disabled={busy}
							className="flex items-center gap-1 px-2 py-1 rounded-md bg-secondary text-foreground hover:bg-secondary/70 transition-colors cursor-pointer text-[9px] disabled:opacity-50 whitespace-nowrap"
						>
							{busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
							测试
						</button>
						<button
							onClick={() => useComfyuiStore.getState().removeEndpoint(ep.id)}
							className="px-2 py-1 rounded-md bg-destructive/15 border border-destructive/30 text-destructive hover:bg-destructive/25 transition-colors cursor-pointer text-[9px] whitespace-nowrap"
						>
							删除
						</button>
					</div>
				);
			})}

			{/* 新增端点行 */}
			<div className="flex items-center gap-2">
				<input
					value={addName}
					onChange={(e) => { setAddName(e.target.value); setAddMsg(""); }}
					placeholder="名称（选填）"
					className="w-28 bg-secondary/40 border border-border/40 rounded-lg px-2.5 py-2 text-[11px] text-foreground outline-none focus:border-primary/60"
				/>
				<input
					value={addUrl}
					onChange={(e) => { setAddUrl(e.target.value); setAddMsg(""); }}
					onKeyDown={(e) => { if (e.key === "Enter") void handleAdd(); }}
					placeholder="http://127.0.0.1:8188 或云实例地址"
					className="flex-1 bg-secondary/40 border border-border/40 rounded-lg px-3 py-2 text-[11px] font-mono text-foreground outline-none focus:border-primary/60"
				/>
				<button
					onClick={() => void handleAdd()}
					className="px-3 py-2 rounded-lg bg-primary text-primary-foreground font-semibold hover:bg-primary/90 transition-colors cursor-pointer text-[10px] whitespace-nowrap"
				>
					添加
				</button>
			</div>
			{addMsg && <span className="text-[10px] text-destructive">{addMsg}</span>}

			<span className="text-[10px] text-muted-foreground">
				绑定后，视频生成的模型下拉会出现「ComfyUI · MiniMax H3」。生成走你自己的 ComfyUI（需已装载 MiniMax H3
				工作流所需模型），消耗你自己的算力，Qiji 每次调用收手续费 {thirdPartyFeeCredits()} 积分。
				绑定多台时，每次生成自动探测各台队列负载并派给最闲的一台（平手轮流）。
			</span>
			{!isTauri() && (
				<span className="text-[10px] text-muted-foreground/70">
					浏览器开发环境需 ComfyUI 以 --enable-cors-header 启动。
				</span>
			)}
		</div>
	);
}

/** 请求记录页（第110轮）：本人任务提交 + 积分扣费/退款一览；详情仅 ①客户端→服务端 ②服务端→客户端 两段。 */
function LogsSection() {
	const PAGE = 30;
	const [items, setItems] = useState<UserLogItem[]>([]);
	const [total, setTotal] = useState(0);
	const [status, setStatus] = useState<"" | "success" | "failed" | "running">("");
	const [loading, setLoading] = useState(false);
	const [err, setErr] = useState("");
	const [openId, setOpenId] = useState<string | null>(null);
	const [detail, setDetail] = useState<UserLogDetail | null>(null);
	const [detailLoading, setDetailLoading] = useState(false);

	const load = async (st: typeof status, offset: number) => {
		setLoading(true);
		setErr("");
		try {
			const r = await managedClient.listLogs({ limit: PAGE, offset, status: st || undefined });
			setTotal(r.total);
			setItems((prev) => (offset === 0 ? r.items : [...prev, ...r.items]));
		} catch (e) {
			setErr((e as Error).message || "加载失败");
		} finally {
			setLoading(false);
		}
	};

	useEffect(() => {
		setOpenId(null);
		setDetail(null);
		void load(status, 0);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [status]);

	const toggleDetail = async (id: string) => {
		if (openId === id) { setOpenId(null); setDetail(null); return; }
		setOpenId(id);
		setDetail(null);
		setDetailLoading(true);
		try {
			setDetail(await managedClient.getLogDetail(id));
		} catch (e) {
			setErr((e as Error).message || "详情加载失败");
			setOpenId(null);
		} finally {
			setDetailLoading(false);
		}
	};

	const fmtTime = (t?: string) => (t ? new Date(t).toLocaleString("zh-CN", { hour12: false }) : "—");
	const pretty = (v: unknown) => { try { return JSON.stringify(v, null, 2); } catch { return String(v); } };
	const StatusChip = ({ s }: { s: UserLogItem["status"] }) =>
		s === "success" ? <span className="px-1.5 py-0.5 rounded bg-green-500/15 border border-green-500/30 text-green-400 text-[9px]">成功</span>
		: s === "failed" ? <span className="px-1.5 py-0.5 rounded bg-red-500/15 border border-red-500/30 text-red-400 text-[9px]">失败</span>
		: <span className="px-1.5 py-0.5 rounded bg-yellow-500/15 border border-yellow-500/30 text-yellow-400 text-[9px]">进行中</span>;
	/** 积分列：成功/进行中=实扣；失败=已退还（异步退回预扣/同步未扣） */
	const CostCell = ({ l }: { l: UserLogItem }) =>
		!l.cost ? <span className="text-muted-foreground">0</span>
		: l.refunded ? (
			<span className="flex items-center gap-1 text-green-400" title="失败已自动退款（异步任务退回预扣积分；同步失败不扣）">
				<Undo2 className="h-3 w-3" /> {l.cost} 已退还
			</span>
		) : <span className="text-foreground">-{l.cost}</span>;

	const chips: { v: typeof status; label: string }[] = [
		{ v: "", label: "全部" }, { v: "success", label: "成功" }, { v: "failed", label: "失败" }, { v: "running", label: "进行中" },
	];

	return (
		<div className="flex flex-col gap-3">
			<div className="flex items-center gap-2">
				<div className="flex items-center gap-1">
					{chips.map((c) => (
						<button
							key={c.v || "all"}
							onClick={() => setStatus(c.v)}
							className={`px-2.5 py-1 rounded-lg text-[10px] cursor-pointer transition-colors border ${status === c.v ? "bg-primary/20 border-primary/40 text-foreground" : "bg-secondary/30 border-border/30 text-muted-foreground hover:text-foreground"}`}
						>
							{c.label}
						</button>
					))}
				</div>
				<span className="text-[10px] text-muted-foreground">共 {total} 条</span>
				<span className="flex-1" />
				<button
					onClick={() => void load(status, 0)}
					disabled={loading}
					className="text-muted-foreground hover:text-foreground rounded-lg p-1 transition-colors cursor-pointer disabled:opacity-50"
					title="刷新"
				>
					{loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
				</button>
			</div>
			{err && <div className="text-[10px] text-destructive">{err}</div>}
			<div className="flex flex-col gap-1.5">
				{items.map((l) => (
					<div key={l.id} className="bg-secondary/30 border border-border/30 rounded-lg overflow-hidden">
						<button
							onClick={() => void toggleDetail(l.id)}
							className="w-full flex items-center gap-2 px-3 py-2 text-left cursor-pointer hover:bg-secondary/40 transition-colors"
						>
							{openId === l.id ? <ChevronDown className="h-3 w-3 text-muted-foreground flex-none" /> : <ChevronRight className="h-3 w-3 text-muted-foreground flex-none" />}
							<span className="text-[10px] text-muted-foreground font-mono whitespace-nowrap">{fmtTime(l.startedAt)}</span>
							<span className="text-[11px] text-foreground whitespace-nowrap">{l.purposeLabel || l.purpose || "—"}</span>
							<span className="text-[10px] text-muted-foreground font-mono truncate">{l.model || ""}</span>
							<span className="flex-1" />
							{/* 第251轮耗时：有排队时显示「实际生成（排队）」，无排队=原单值口径 */}
							<span
								className="text-[10px] text-muted-foreground font-mono whitespace-nowrap"
								title={l.queuedMs ? "实际生成秒数（排队秒数）——排队不计入生成时长" : "本次耗时"}
							>
								{formatDurationWithQueue(l.durationMs, l.queuedMs)}
							</span>
							<span className="text-[10px] font-mono whitespace-nowrap"><CostCell l={l} /></span>
							<StatusChip s={l.status} />
						</button>
						{openId === l.id && (
							<div className="border-t border-border/30 px-3 py-2 flex flex-col gap-2">
								{detailLoading ? (
									<span className="flex items-center gap-1.5 text-[10px] text-muted-foreground py-2"><Loader2 className="h-3 w-3 animate-spin" /> 加载详情…</span>
								) : detail ? (
									<>
										{detail.error && <div className="text-[10px] text-destructive break-all">失败原因：{detail.error}</div>}
										{detail.resultLink && (
											<div className="text-[10px] text-muted-foreground break-all">结果链接：<span className="font-mono text-foreground">{detail.resultLink}</span></div>
										)}
										<div className="flex flex-col gap-1">
											<span className="text-[10px] font-semibold text-primary">① 客户端 → 服务端（请求）</span>
											<pre className="text-[9.5px] leading-relaxed font-mono bg-black/30 border border-border/30 rounded-lg p-2 max-h-48 overflow-auto Qiji-scroll-thin whitespace-pre-wrap break-all">{pretty(detail.request ?? "（无）")}</pre>
										</div>
										<div className="flex flex-col gap-1">
											<span className="text-[10px] font-semibold text-primary">② 服务端 → 客户端（响应）</span>
											<pre className="text-[9.5px] leading-relaxed font-mono bg-black/30 border border-border/30 rounded-lg p-2 max-h-48 overflow-auto Qiji-scroll-thin whitespace-pre-wrap break-all">{pretty(detail.response ?? "（无 / 任务尚未完成）")}</pre>
										</div>
									</>
								) : null}
							</div>
						)}
					</div>
				))}
				{!loading && !items.length && <div className="text-[10px] text-muted-foreground text-center py-6">暂无请求记录</div>}
			</div>
			{items.length < total && (
				<button
					onClick={() => void load(status, items.length)}
					disabled={loading}
					className="self-center px-4 py-1.5 rounded-lg bg-secondary/40 border border-border/30 text-muted-foreground hover:text-foreground text-[10px] cursor-pointer transition-colors disabled:opacity-50"
				>
					{loading ? "加载中…" : `加载更多（已显示 ${items.length}/${total}）`}
				</button>
			)}
		</div>
	);
}

/** 团队页（第172轮）：团队码开团（开团者=团长）；团长邀请成员（对方接受才入团）/积分方式/分发收回
 *（收回上限=分发净额，团员自有积分不可收缴）；团员看概要可退出（分发余量自动退回团长）。 */
function TeamSection({ onChanged }: { onChanged: () => void }) {
	const [team, setTeam] = useState<TeamDetail | null>(null);
	const [invites, setInvites] = useState<TeamInviteInfo[]>([]);
	const [loading, setLoading] = useState(true);
	const [err, setErr] = useState("");
	const [busy, setBusy] = useState(false);
	const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

	// 开团表单
	const [openCode, setOpenCode] = useState("");
	const [openName, setOpenName] = useState("");
	// 团长：邀请 + 分发/收回金额
	const [addAcct, setAddAcct] = useState("");
	const [amount, setAmount] = useState("1000");

	const load = async () => {
		setLoading(true);
		setErr("");
		try {
			const r = await managedClient.getTeam();
			setTeam(r.team);
			setInvites(r.invites ?? []);
		} catch (e) {
			setErr((e as Error).message || "加载失败");
		} finally {
			setLoading(false);
		}
	};
	useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

	/** 统一动作壳：执行 → 提示 → 刷新团队与概览积分 */
	const act = async (fn: () => Promise<{ ok: boolean; error?: string }>, okText: string) => {
		if (busy) return;
		setBusy(true);
		setMsg(null);
		const r = await fn();
		setBusy(false);
		if (r.ok) {
			setMsg({ ok: true, text: okText });
			void load();
			onChanged();
		} else {
			setMsg({ ok: false, text: r.error || "操作失败" });
		}
	};

	const amountNum = () => Math.max(0, Math.floor(Number(amount) || 0));

	const modeBtn = (mode: "dispatch" | "shared", label: string) => (
		<button
			onClick={() => {
				if (!team || team.creditMode === mode) return;
				void (async () => {
					const ok = await confirmDialog(
						mode === "shared"
							? "切换为「共享积分模式」？\n团员生成消耗将直接从你（团长）的积分余额扣除（共享池=你的余额），团员自己的积分不动。"
							: "切换为「分发积分模式」？\n团员生成消耗扣团员自己的积分；你可以把积分分发给团员或从团员收回。",
					);
					if (!ok) return;
					await act(() => managedClient.updateTeam({ creditMode: mode }), "积分方式已切换");
				})();
			}}
			disabled={busy}
			className={`px-3 py-1.5 rounded-lg text-[10px] cursor-pointer transition-colors border ${team?.creditMode === mode ? "bg-primary/20 border-primary/40 text-foreground font-semibold" : "bg-secondary/30 border-border/30 text-muted-foreground hover:text-foreground"}`}
		>
			{label}
		</button>
	);

	if (loading) {
		return <div className="flex items-center gap-2 text-[11px] text-muted-foreground py-8 justify-center"><Loader2 className="h-3.5 w-3.5 animate-spin" /> 加载团队信息…</div>;
	}
	if (err) {
		return <div className="text-[11px] text-destructive py-6 text-center">{err}</div>;
	}

	// ── 未在团队：收到的邀请（接受才入团）+ 开团表单 ──
	if (!team) {
		return (
			<div className="flex flex-col gap-3">
				{invites.length > 0 && (
					<div className="flex flex-col gap-2">
						<div className="text-xs font-semibold text-foreground">收到的团队邀请</div>
						{invites.map((iv) => (
							<div key={iv.teamId} className="flex items-center gap-2 bg-primary/10 border border-primary/30 rounded-lg px-3 py-2.5">
								<div className="flex flex-col min-w-0 flex-1">
									<span className="text-[11px] text-foreground truncate">「{iv.teamName}」邀请你加入</span>
									<span className="text-[9px] text-muted-foreground">
										团长：{iv.leaderName || "—"} · {iv.memberCount} 人 · {iv.creditMode === "shared" ? "共享积分模式（消耗扣团长池）" : "分发积分模式（消耗扣自己）"}
									</span>
								</div>
								<button
									onClick={() => void act(() => managedClient.acceptTeamInvite(iv.teamId), "已加入团队")}
									disabled={busy}
									className="px-3 py-1.5 rounded bg-primary text-primary-foreground text-[10px] font-semibold cursor-pointer hover:bg-primary/90 transition-colors disabled:opacity-50"
								>
									接受
								</button>
								<button
									onClick={() => void act(() => managedClient.declineTeamInvite(iv.teamId), "已拒绝邀请")}
									disabled={busy}
									className="px-3 py-1.5 rounded bg-secondary/50 border border-border/40 text-foreground text-[10px] cursor-pointer hover:bg-secondary transition-colors disabled:opacity-50"
								>
									拒绝
								</button>
							</div>
						))}
					</div>
				)}
				<div className="text-[11px] text-muted-foreground leading-relaxed">
					团队=用户互相绑定：凭管理员发放的<b className="text-foreground">团队码</b>开团，开团者即<b className="text-foreground">团长</b>。
					团长可邀请团员（<b className="text-foreground">对方接受才入团</b>）、分发/收回积分（收回仅限自己分发的部分），
					并可选择积分方式（共享池 或 分发制）；每个团队自动附带一份
					<b className="text-foreground">团队共享素材库</b>（资产助手「共享资产」中团员自动可见，团长管理）。
				</div>
				<div className="flex flex-col gap-2">
					<input
						value={openCode}
						onChange={(e) => setOpenCode(e.target.value)}
						placeholder="团队码（tc-…，向管理员或你的服务商获取）"
						className="bg-secondary/40 border border-border/40 rounded-lg px-3 py-2 text-[11px] font-mono text-foreground outline-none focus:border-primary/60"
					/>
					<div className="flex items-center gap-2">
						<input
							value={openName}
							onChange={(e) => setOpenName(e.target.value)}
							placeholder="团队名（1–20 字）"
							className="flex-1 bg-secondary/40 border border-border/40 rounded-lg px-3 py-2 text-[11px] text-foreground outline-none focus:border-primary/60"
						/>
						<button
							onClick={() => void act(() => managedClient.createTeam(openCode.trim(), openName.trim()), "开团成功，你已成为团长")}
							disabled={busy || !openCode.trim() || !openName.trim()}
							className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary text-primary-foreground font-semibold hover:bg-primary/90 transition-colors cursor-pointer text-[11px] disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
						>
							{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Users className="h-3.5 w-3.5" />}
							开团
						</button>
					</div>
				</div>
				{msg && (
					<span className={`flex items-center gap-1 text-[10px] ${msg.ok ? "text-green-400" : "text-destructive"}`}>
						{msg.ok ? <CheckCircle className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}{msg.text}
					</span>
				)}
			</div>
		);
	}

	// ── 团队卡片（两种角色共用头部）──
	const header = (
		<div className="bg-gradient-to-br from-primary/20 to-primary/5 border border-primary/30 rounded-xl px-5 py-4 flex items-center justify-between">
			<div className="flex flex-col gap-1">
				<span className="text-[10px] text-muted-foreground flex items-center gap-1"><Users className="h-3 w-3" /> 团队</span>
				<span className="text-lg font-bold text-foreground">{team.name}</span>
				<span className="text-[10px] text-muted-foreground">
					{team.role === "leader" ? "你是团长" : `团长：${team.leaderName || "—"}`} · {team.memberCount}
					{team.memberLimit ? `/${team.memberLimit}` : ""} 人 ·{" "}
					{team.creditMode === "shared" ? "共享积分模式" : "分发积分模式"}
				</span>
			</div>
			{team.creditMode === "shared" && (
				<div className="flex flex-col items-end gap-0.5">
					<span className="text-[10px] text-muted-foreground">团队共享池</span>
					<span className="text-xl font-bold text-foreground font-mono">{(team.poolCredits ?? 0).toLocaleString()}</span>
				</div>
			)}
		</div>
	);

	// ── 团员视角 ──
	if (team.role !== "leader") {
		return (
			<div className="flex flex-col gap-3">
				{header}
				<div className="text-[10px] text-muted-foreground leading-relaxed">
					{team.creditMode === "shared"
						? "共享积分模式：你的生成消耗直接从团队共享池（团长积分）扣除。"
						: "分发积分模式：生成消耗扣你自己的积分；需要额度可请团长分发。"}
					{team.sharedLibId ? "团队共享素材库在资产助手「共享资产」中可见。" : ""}
				</div>
				<button
					onClick={() => {
						void (async () => {
							const ok = await confirmDialog(`退出团队「${team.name}」？\n退出后不再使用团队积分/共享素材库；团长分发给你的积分余量将自动退回团长，你自有的积分保持现状。`);
							if (!ok) return;
							await act(() => managedClient.leaveTeam(), "已退出团队");
						})();
					}}
					disabled={busy}
					className="self-start flex items-center gap-1.5 px-4 py-2 rounded-lg bg-destructive/10 border border-destructive/30 text-destructive hover:bg-destructive/20 font-semibold cursor-pointer transition-colors text-[11px] disabled:opacity-50"
				>
					<LogOut className="h-3.5 w-3.5" /> 退出团队
				</button>
				{msg && (
					<span className={`flex items-center gap-1 text-[10px] ${msg.ok ? "text-green-400" : "text-destructive"}`}>
						{msg.ok ? <CheckCircle className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}{msg.text}
					</span>
				)}
			</div>
		);
	}

	// ── 团长视角 ──
	return (
		<div className="flex flex-col gap-4">
			{header}

			{/* 积分方式 */}
			<div className="flex flex-col gap-2">
				<div className="text-xs font-semibold text-foreground">积分方式（团长决定）</div>
				<div className="flex items-center gap-2">
					{modeBtn("dispatch", "分发积分：各扣各的，可分发/收回")}
					{modeBtn("shared", "共享积分：团员消耗直接扣团长池")}
				</div>
			</div>

			{/* 邀请团员（邀请-同意制：对方在其个人中心「团队」页接受才入团） */}
			<div className="flex flex-col gap-2">
				<div className="text-xs font-semibold text-foreground">邀请团员</div>
				<div className="flex items-center gap-2">
					<input
						value={addAcct}
						onChange={(e) => setAddAcct(e.target.value)}
						onKeyDown={(e) => { if (e.key === "Enter" && addAcct.trim()) void act(() => managedClient.inviteTeamMember(addAcct.trim()).then((r) => { if (r.ok) setAddAcct(""); return r; }), "邀请已发出，等待对方在个人中心「团队」页接受"); }}
						placeholder="对方登录账号（需已注册；对方接受后入团，不限归属）"
						className="flex-1 bg-secondary/40 border border-border/40 rounded-lg px-3 py-2 text-[11px] font-mono text-foreground outline-none focus:border-primary/60"
					/>
					<button
						onClick={() => void act(() => managedClient.inviteTeamMember(addAcct.trim()).then((r) => { if (r.ok) setAddAcct(""); return r; }), "邀请已发出，等待对方在个人中心「团队」页接受")}
						disabled={busy || !addAcct.trim()}
						className="px-4 py-2 rounded-lg bg-primary text-primary-foreground font-semibold hover:bg-primary/90 transition-colors cursor-pointer text-[11px] disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
					>
						发出邀请
					</button>
				</div>
				{(team.pendingInvites ?? []).length > 0 && (
					<div className="flex flex-col gap-1">
						{(team.pendingInvites ?? []).map((iv) => (
							<div key={iv.userId} className="flex items-center gap-2 bg-secondary/20 border border-border/20 rounded px-3 py-1.5">
								<span className="text-[10px] text-muted-foreground flex-1 truncate">
									待接受：{iv.name}{iv.account ? <span className="font-mono"> @{iv.account}</span> : null}（7 天未处理自动过期）
								</span>
								<button
									onClick={() => void act(() => managedClient.cancelTeamInvite(iv.userId), "已撤销邀请")}
									disabled={busy}
									className="px-2 py-0.5 rounded text-destructive/80 hover:text-destructive hover:bg-destructive/10 text-[10px] cursor-pointer transition-colors disabled:opacity-50"
								>
									撤销
								</button>
							</div>
						))}
					</div>
				)}
			</div>

			{/* 成员列表 + 分发/收回 */}
			<div className="flex flex-col gap-2">
				<div className="flex items-center justify-between">
					<div className="text-xs font-semibold text-foreground">团员（{team.members?.length ?? 0}）</div>
					<div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
						数量
						<input
							value={amount}
							onChange={(e) => setAmount(e.target.value)}
							className="w-20 bg-secondary/40 border border-border/40 rounded px-2 py-1 text-[10px] font-mono text-foreground outline-none focus:border-primary/60 text-right"
							title="分发/收回的积分数量"
						/>
					</div>
				</div>
				<div className="flex flex-col gap-1.5">
					{(team.members ?? []).map((m) => (
						<div key={m.id} className="flex items-center gap-2 bg-secondary/30 border border-border/30 rounded-lg px-3 py-2">
							<div className="flex flex-col min-w-0 flex-1">
								<span className="text-[11px] text-foreground truncate">{m.name}{m.account ? <span className="text-muted-foreground font-mono"> @{m.account}</span> : null}</span>
								<span className="text-[9px] text-muted-foreground font-mono">
									积分 {m.credits.toLocaleString()} · 今日消耗 {m.dailySpent.toLocaleString()} · 可收回 {(m.reclaimable ?? 0).toLocaleString()}
								</span>
							</div>
							<button
								onClick={() => void act(() => managedClient.teamCredits(m.id, amountNum()), `已分发 ${amountNum()} 积分`)}
								disabled={busy || amountNum() <= 0}
								className="px-2.5 py-1 rounded bg-primary/15 border border-primary/30 text-primary text-[10px] cursor-pointer hover:bg-primary/25 transition-colors disabled:opacity-50"
								title="从你的余额分发给该团员"
							>
								分发
							</button>
							<button
								onClick={() => void act(() => managedClient.teamCredits(m.id, -amountNum()), `已收回 ${amountNum()} 积分`)}
								disabled={busy || amountNum() <= 0 || (m.reclaimable ?? 0) <= 0}
								className="px-2.5 py-1 rounded bg-secondary/50 border border-border/40 text-foreground text-[10px] cursor-pointer hover:bg-secondary transition-colors disabled:opacity-50"
								title={`收回你分发的积分（可收回 ${(m.reclaimable ?? 0).toLocaleString()}——仅限你分发的部分，团员自有积分不可收缴）`}
							>
								收回
							</button>
							<button
								onClick={() => {
									void (async () => {
										const ok = await confirmDialog(`将「${m.name}」移出团队？\n你分发的积分余量（${(m.reclaimable ?? 0).toLocaleString()}）将自动退回给你；其自有积分保持现状。`);
										if (!ok) return;
										await act(() => managedClient.removeTeamMember(m.id), "已移出团队（分发余量已退回）");
									})();
								}}
								disabled={busy}
								className="px-2 py-1 rounded text-destructive/80 hover:text-destructive hover:bg-destructive/10 text-[10px] cursor-pointer transition-colors disabled:opacity-50"
								title="移出团队（分发余量自动退回）"
							>
								移除
							</button>
						</div>
					))}
					{!(team.members ?? []).length && (
						<div className="text-[10px] text-muted-foreground text-center py-4">还没有团员——在上方输入对方登录账号发出邀请，对方接受后入团</div>
					)}
				</div>
			</div>

			{/* 共享素材库 + 解散 */}
			<div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground bg-secondary/20 border border-border/20 rounded-lg px-3 py-2">
				<span>团队共享素材库：<b className="text-foreground">{team.sharedLibName || "—"}</b>（资产助手「共享资产」中管理，团员自动可见）</span>
			</div>
			<button
				onClick={() => {
					void (async () => {
						const ok = await confirmDialog(`解散团队「${team.name}」？\n你分发给各团员的积分余量将自动退回给你；团员自有积分保持现状；团队共享素材库将一并删除（素材记录，不动文件）；团队码不可复用。此操作不可撤销。`);
						if (!ok) return;
						await act(() => managedClient.dissolveTeam(), "团队已解散");
					})();
				}}
				disabled={busy}
				className="self-start flex items-center gap-1.5 px-4 py-2 rounded-lg bg-destructive/10 border border-destructive/30 text-destructive hover:bg-destructive/20 font-semibold cursor-pointer transition-colors text-[11px] disabled:opacity-50"
			>
				解散团队
			</button>
			{msg && (
				<span className={`flex items-center gap-1 text-[10px] ${msg.ok ? "text-green-400" : "text-destructive"}`}>
					{msg.ok ? <CheckCircle className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}{msg.text}
				</span>
			)}
		</div>
	);
}

/** 消耗统计页（第173轮）：今日/昨日/近7天（按请求日志聚合，共享模式消耗仍记消耗者名下）；
 *  团长可按团员筛选（我自己 / 全团合计 / 各团员）。 */
/* ── 批量下载（第232轮）────────────────────────────────────────────────
   把服务端记下的成功产物一次性抓到本地文件夹。

   为什么要有它：服务端转存 OSS 失败时会**回退上游原链**完成任务（绝不整单报废，第158轮），
   那些产物没有永久直链、也不在资产台账里——不批量抓下来就只能一个个手点，而且原链会过期。

   ⚠ 原链时效 2~24 小时不等，清单按时间倒序（新的先抓），过期风险如实标注。
   ⚠ 少数渠道的原链下载须带上游密钥（密钥绝不外发）→ 标「需服务端代下」，直连必失败，
     这里如实跳过并计数，不假装成功。 */
type DlRangeKey = "today" | "3d" | "7d" | "30d" | "all";
const DL_RANGES: [DlRangeKey, string][] = [["today", "今天"], ["3d", "近 3 天"], ["7d", "近 7 天"], ["30d", "近 30 天"], ["all", "全部"]];
const DL_STORAGE_TABS: [DownloadLinkStorage | "", string, string][] = [
	["", "全部", "本人全部成功产物"],
	["raw", "仅上游原链", "服务端未能转存、只有上游临时链接的产物——会过期，要尽快抓"],
	["oss", "仅云端已存", "已存进云端对象存储的产物，链接永久有效"],
];
const DL_KIND_TABS: [DownloadMediaKind | "", string][] = [["", "全部类型"], ["image", "图片"], ["video", "视频"], ["audio", "音频"]];

function dlRangeFrom(k: DlRangeKey): number | undefined {
	if (k === "all") return undefined;
	const d = new Date();
	d.setHours(0, 0, 0, 0);
	const DAY = 86400000;
	if (k === "today") return d.getTime();
	if (k === "3d") return d.getTime() - 2 * DAY;
	if (k === "7d") return d.getTime() - 6 * DAY;
	return d.getTime() - 29 * DAY;
}

function DownloadsSection() {
	const [range, setRange] = useState<DlRangeKey>("7d");
	const [storage, setStorage] = useState<DownloadLinkStorage | "">("raw");
	const [kind, setKind] = useState<DownloadMediaKind | "">("");
	const [manifest, setManifest] = useState<DownloadManifest | null>(null);
	const [loading, setLoading] = useState(true);
	const [err, setErr] = useState("");
	const [running, setRunning] = useState(false);
	const [prog, setProg] = useState<BatchDownloadProgress | null>(null);
	const [result, setResult] = useState<BatchDownloadResult | null>(null);
	// ⚠ 取消标记必须走 ref：下载 worker 循环里读 state 拿到的是启动那一刻的闭包旧值，点了取消不会生效
	const stopRef = useRef(false);

	const load = async () => {
		setLoading(true);
		setErr("");
		try {
			setManifest(await managedClient.getDownloadManifest({
				from: dlRangeFrom(range),
				storages: storage ? [storage] : undefined,
				kinds: kind ? [kind] : undefined,
			}));
		} catch (e) {
			setErr((e as Error).message || "加载失败");
			setManifest(null);
		} finally {
			setLoading(false);
		}
	};

	useEffect(() => {
		void load();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [range, storage, kind]);

	const start = async () => {
		if (!manifest?.total || running) return;
		const { open } = await import("@tauri-apps/plugin-dialog");
		const picked = await open({ directory: true, multiple: false, title: "选择保存到哪个文件夹" });
		const root = typeof picked === "string" ? picked : null;
		if (!root) return;
		stopRef.current = false;
		setRunning(true);
		setResult(null);
		setProg({ done: 0, total: manifest.items.length, ok: 0, skipped: 0, blocked: 0, failed: 0, bytes: 0 });
		const r = await runBatchDownload(manifest.items, {
			root,
			onProgress: setProg,
			shouldStop: () => stopRef.current,
		});
		setResult(r);
		setRunning(false);
	};

	const expired = manifest?.items.filter((i) => i.expiryRisk === "expired").length ?? 0;
	const Chip = ({ on, onClick, title, children }: { on: boolean; onClick: () => void; title?: string; children: React.ReactNode }) => (
		<button
			onClick={onClick}
			title={title}
			className={`px-2.5 py-1 rounded-lg text-[10px] cursor-pointer transition-colors ${on ? "bg-primary/20 text-foreground font-semibold" : "bg-secondary/30 text-muted-foreground hover:text-foreground"}`}
		>
			{children}
		</button>
	);

	return (
		<div className="flex flex-col gap-3">
			{/* 筛选 */}
			<div className="flex flex-col gap-2">
				<div className="flex items-center gap-1.5 flex-wrap">
					<span className="text-[10px] text-muted-foreground w-12 shrink-0">时间</span>
					{DL_RANGES.map(([k, lb]) => <Chip key={k} on={range === k} onClick={() => setRange(k)}>{lb}</Chip>)}
				</div>
				<div className="flex items-center gap-1.5 flex-wrap">
					<span className="text-[10px] text-muted-foreground w-12 shrink-0">保存</span>
					{DL_STORAGE_TABS.map(([v, lb, tip]) => <Chip key={v} on={storage === v} onClick={() => setStorage(v)} title={tip}>{lb}</Chip>)}
				</div>
				<div className="flex items-center gap-1.5 flex-wrap">
					<span className="text-[10px] text-muted-foreground w-12 shrink-0">类型</span>
					{DL_KIND_TABS.map(([v, lb]) => <Chip key={v} on={kind === v} onClick={() => setKind(v)}>{lb}</Chip>)}
				</div>
			</div>

			{loading ? (
				<div className="flex items-center gap-2 text-[11px] text-muted-foreground py-6 justify-center">
					<Loader2 className="h-3.5 w-3.5 animate-spin" /> 正在读取…
				</div>
			) : err ? (
				<div className="text-[11px] text-red-400 py-4 text-center">{err}</div>
			) : !manifest?.total ? (
				<div className="text-[11px] text-muted-foreground py-6 text-center">该条件下没有可下载的产物</div>
			) : (
				<>
					{/* 概况 */}
					<div className="grid grid-cols-3 gap-2">
						<div className="flex flex-col gap-1 bg-secondary/30 border border-border/30 rounded-lg px-3 py-2.5">
							<span className="text-[10px] text-muted-foreground">可下载</span>
							<span className="text-lg font-bold text-foreground font-mono">{manifest.total.toLocaleString()}</span>
						</div>
						<div className="flex flex-col gap-1 bg-secondary/30 border border-border/30 rounded-lg px-3 py-2.5">
							<span className="text-[10px] text-muted-foreground">其中原链</span>
							<span className="text-lg font-bold text-foreground font-mono">{manifest.byStorage.raw.toLocaleString()}</span>
						</div>
						<div className="flex flex-col gap-1 bg-secondary/30 border border-border/30 rounded-lg px-3 py-2.5">
							<span className="text-[10px] text-muted-foreground">需服务端代下</span>
							<span className="text-lg font-bold text-foreground font-mono">{manifest.authRequired.toLocaleString()}</span>
						</div>
					</div>

					{/* 如实告知的三条边界 */}
					{manifest.truncated && (
						<div className="text-[10px] text-amber-400 bg-amber-400/10 border border-amber-400/20 rounded-lg px-3 py-2">
							共匹配 {manifest.matched.toLocaleString()} 个，已截断到 {manifest.total.toLocaleString()} 个——请缩小时间范围分批下载，否则会漏掉一部分。
						</div>
					)}
					{expired > 0 && (
						<div className="text-[10px] text-amber-400 bg-amber-400/10 border border-amber-400/20 rounded-lg px-3 py-2">
							其中 {expired.toLocaleString()} 个是超过 24 小时的临时链接，<b>可能已经失效</b>（服务端未能转存时给的是上游临时地址，有效期 2~24 小时）。失效的会在下载时报错列出。
						</div>
					)}
					{manifest.authRequired > 0 && (
						<div className="text-[10px] text-muted-foreground bg-secondary/30 border border-border/30 rounded-lg px-3 py-2">
							有 {manifest.authRequired.toLocaleString()} 个产物的链接需要服务端凭密钥代取，本机直连下不了，会自动跳过——请联系管理员处理。
						</div>
					)}

					{/* 操作 */}
					<div className="flex items-center gap-2">
						<button
							onClick={() => void start()}
							disabled={running}
							className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] bg-primary/20 text-foreground font-semibold hover:bg-primary/30 disabled:opacity-50 cursor-pointer transition-colors"
						>
							{running ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
							{running ? "下载中…" : `下载全部（${manifest.total}）`}
						</button>
						{running && (
							<button
								onClick={() => { stopRef.current = true; }}
								className="px-3 py-1.5 rounded-lg text-[11px] bg-secondary/40 text-muted-foreground hover:text-foreground cursor-pointer transition-colors"
							>
								取消
							</button>
						)}
						<span className="text-[9px] text-muted-foreground flex-1">按 用户/日期/步骤 自动分目录；重复下载会跳过已存在的文件</span>
					</div>

					{/* 进度 */}
					{prog && (
						<div className="flex flex-col gap-1.5 bg-secondary/30 border border-border/30 rounded-lg px-3 py-2.5">
							<div className="h-1.5 bg-secondary/60 rounded-full overflow-hidden">
								<div className="h-full bg-primary transition-[width] duration-200" style={{ width: `${prog.total ? (prog.done / prog.total) * 100 : 0}%` }} />
							</div>
							<div className="text-[10px] text-muted-foreground font-mono">
								{prog.done}/{prog.total} · 成功 {prog.ok} · 跳过 {prog.skipped} · 需代下 {prog.blocked} · 失败 {prog.failed} · {fmtBytes(prog.bytes)}
							</div>
							{running && prog.current && <div className="text-[9px] text-muted-foreground truncate">{prog.current}</div>}
						</div>
					)}

					{/* 结果与失败清单（失败项如实列出，绝不吞） */}
					{result && (
						<div className="flex flex-col gap-2">
							<div className="text-[11px] text-foreground">
								{result.cancelled ? "已取消。" : "下载完成。"}
								成功 {result.ok} 个（{fmtBytes(result.bytes)}）
								{result.skipped > 0 && `，跳过已存在 ${result.skipped} 个`}
								{result.blocked > 0 && `，需服务端代下 ${result.blocked} 个`}
								{result.failed > 0 && `，失败 ${result.failed} 个`}
							</div>
							{result.failures.length > 0 && (
								<div className="flex flex-col gap-1 max-h-40 overflow-y-auto Qiji-scroll-thin">
									{result.failures.slice(0, 50).map((f, i) => (
										<div key={i} className="text-[9px] text-red-400 bg-red-400/5 border border-red-400/15 rounded px-2 py-1">
											<div className="truncate">{f.item.suggestedPath}</div>
											<div className="text-muted-foreground truncate">
												{f.error}
												{f.item.expiryRisk === "expired" && " · 该链接已超 24 小时，多半是过期了"}
											</div>
										</div>
									))}
									{result.failures.length > 50 && (
										<div className="text-[9px] text-muted-foreground">另有 {result.failures.length - 50} 个失败未展开</div>
									)}
								</div>
							)}
						</div>
					)}

					{/* 清单预览（只列前若干条，让用户对得上号） */}
					<div className="flex flex-col gap-1">
						<span className="text-[10px] text-muted-foreground">清单预览（前 30 个，按时间倒序）</span>
						<div className="flex flex-col gap-0.5 max-h-52 overflow-y-auto Qiji-scroll-thin">
							{manifest.items.slice(0, 30).map((it, i) => (
								<div key={i} className="flex items-center gap-2 text-[9px] px-2 py-1 rounded bg-secondary/20">
									<span className="text-muted-foreground shrink-0 w-24 truncate">{new Date(it.startedAt).toLocaleString()}</span>
									<span className="text-foreground shrink-0">{it.purposeLabel}</span>
									<span className="text-muted-foreground truncate flex-1">{it.suggestedPath}</span>
									{it.storage === "raw" && <span className="text-amber-400 shrink-0">临时链接</span>}
									{it.authRequired && <span className="text-red-400 shrink-0">需代下</span>}
								</div>
							))}
						</div>
					</div>
				</>
			)}
		</div>
	);
}

function StatsSection() {
	const [data, setData] = useState<UserConsumeStats | null>(null);
	const [team, setTeam] = useState<TeamDetail | null>(null);
	const [sel, setSel] = useState<string>("me"); // me | team | <团员 userId>
	const [bkRange, setBkRange] = useState<"today" | "yesterday" | "week">("today"); // 明细（按模型/步骤）时段
	const [bkKind, setBkKind] = useState<"model" | "purpose">("model"); // 明细维度切换（同屏只显示一张表，控制面板高度）
	const [loading, setLoading] = useState(true);
	const [err, setErr] = useState("");

	const load = async (s: string) => {
		setLoading(true);
		setErr("");
		try {
			const opts = s === "me" ? undefined : s === "team" ? { scope: "team" as const } : { userId: s };
			setData(await managedClient.getStats(opts));
		} catch (e) {
			setErr((e as Error).message || "加载失败");
			setData(null);
		} finally {
			setLoading(false);
		}
	};

	useEffect(() => {
		void managedClient.getTeam().then((r) => setTeam(r.team)).catch(() => { /* 团队信息拿不到不影响个人统计 */ });
		void load("me");
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const isLeader = team?.role === "leader";

	const RangeCard = ({ label, r }: { label: string; r?: { credits: number; count: number; success: number; failed: number } }) => (
		<div className="flex flex-col gap-1 bg-secondary/30 border border-border/30 rounded-lg px-4 py-3">
			<span className="text-[10px] text-muted-foreground">{label}</span>
			<span className="text-lg font-bold text-foreground font-mono">{(r?.credits ?? 0).toLocaleString()}</span>
			<span className="text-[9px] text-muted-foreground">
				{r ? `${r.count} 次（成功 ${r.success} · 失败 ${r.failed}）` : "—"}
			</span>
		</div>
	);

	return (
		<div className="flex flex-col gap-3">
			{isLeader && (
				<div className="flex items-center gap-2">
					<span className="text-[10px] text-muted-foreground whitespace-nowrap">统计对象</span>
					<select
						value={sel}
						onChange={(e) => { setSel(e.target.value); void load(e.target.value); }}
						className="flex-1 bg-secondary/40 border border-border/40 rounded-lg px-3 py-2 text-[11px] text-foreground outline-none focus:border-primary/60 cursor-pointer"
					>
						<option value="me">我自己（团长）</option>
						<option value="team">全团合计</option>
						{(team?.members ?? []).map((m) => (
							<option key={m.id} value={m.id}>团员：{m.name}{m.account ? ` @${m.account}` : ""}</option>
						))}
					</select>
					<button
						onClick={() => void load(sel)}
						disabled={loading}
						className="text-muted-foreground hover:text-foreground rounded-lg p-1.5 transition-colors cursor-pointer disabled:opacity-50"
						title="刷新"
					>
						{loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
					</button>
				</div>
			)}
			{!isLeader && (
				<div className="flex items-center justify-between">
					<span className="text-[10px] text-muted-foreground">按请求记录聚合的消耗积分（含成功与进行中，失败已退不计）</span>
					<button
						onClick={() => void load(sel)}
						disabled={loading}
						className="text-muted-foreground hover:text-foreground rounded-lg p-1.5 transition-colors cursor-pointer disabled:opacity-50"
						title="刷新"
					>
						{loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
					</button>
				</div>
			)}
			{err && <div className="text-[10px] text-destructive">{err}</div>}
			{loading && !data ? (
				<div className="flex items-center gap-2 text-[11px] text-muted-foreground py-8 justify-center">
					<Loader2 className="h-3.5 w-3.5 animate-spin" /> 加载统计…
				</div>
			) : data ? (
				<>
					<div className="text-[10px] text-muted-foreground">
						{data.target.scope === "team" ? `全团合计 · ${data.target.name ?? ""}` : `统计对象：${data.target.name ?? "我"}`}
					</div>
					<div className="grid grid-cols-3 gap-3">
						<RangeCard label="今日消耗" r={data.ranges.today} />
						<RangeCard label="昨日消耗" r={data.ranges.yesterday} />
						<RangeCard label="近 7 天消耗" r={data.ranges.week} />
					</div>

					{/* 明细：时段 + 维度切换（同屏只显示一张表，成功次数 + 实际消耗积分，失败已退不计） */}
					<div className="flex items-center gap-1.5 pt-1 flex-wrap">
						<span className="text-[10px] text-muted-foreground">明细</span>
						{([["today", "今日"], ["yesterday", "昨日"], ["week", "近 7 天"]] as const).map(([k, lb]) => (
							<button
								key={k}
								onClick={() => setBkRange(k)}
								className={`px-2.5 py-1 rounded text-[10px] cursor-pointer transition-colors border ${bkRange === k ? "bg-primary/20 border-primary/40 text-foreground font-semibold" : "bg-secondary/30 border-border/30 text-muted-foreground hover:text-foreground"}`}
							>
								{lb}
							</button>
						))}
						<span className="w-px h-4 bg-border/40 mx-0.5" />
						{([["model", "按模型"], ["purpose", "按步骤"]] as const).map(([k, lb]) => (
							<button
								key={k}
								onClick={() => setBkKind(k)}
								className={`px-2.5 py-1 rounded text-[10px] cursor-pointer transition-colors border ${bkKind === k ? "bg-primary/20 border-primary/40 text-foreground font-semibold" : "bg-secondary/30 border-border/30 text-muted-foreground hover:text-foreground"}`}
							>
								{lb}
							</button>
						))}
					</div>
					{bkKind === "model" ? (
						<FamilyBreakdownTable groups={data.ranges[bkRange].byFamily ?? []} />
					) : (
						<BreakdownTable
							kind="purpose"
							rows={(data.ranges[bkRange].byPurpose ?? []).map((p) => ({ key: p.purpose, name: p.label, success: p.success, count: p.count, credits: p.credits }))}
						/>
					)}

					{isLeader && (
						<div className="text-[9px] text-muted-foreground">
							共享积分模式下团员的消耗从团队池（你的积分）扣，但统计仍记在各消耗者名下——用上方筛选查看各团员用量。
						</div>
					)}
				</>
			) : null}
		</div>
	);
}

/** 按模型明细：先按**家族池**汇总，点击家族行展开查看组内具体模型（第173轮）。
 *  列同 BreakdownTable：名称 | 成功次数 | 实际消耗积分；表体自身滚动，不撑高面板。 */
function FamilyBreakdownTable({ groups }: { groups: NonNullable<ConsumeRangeStats["byFamily"]> }) {
	const [open, setOpen] = useState<Record<string, boolean>>({});
	const shown = groups.filter((g) => g.count > 0);
	return (
		<div className="bg-secondary/20 border border-border/20 rounded-lg overflow-hidden">
			<div className="grid grid-cols-[1fr_auto_auto] gap-x-4 px-3 py-1.5 text-[9px] text-muted-foreground border-b border-border/20">
				<span>模型家族（点击展开具体模型）</span>
				<span className="text-right w-16">成功次数</span>
				<span className="text-right w-24">实际消耗积分</span>
			</div>
			{shown.length === 0 ? (
				<div className="text-[10px] text-muted-foreground text-center py-3">该时段暂无消耗</div>
			) : (
				<div className="max-h-[240px] overflow-y-auto Qiji-scroll-thin">
					{shown.map((g) => {
						const key = g.familyId || "__other";
						const expanded = !!open[key];
						return (
							<div key={key} className="border-b border-border/10 last:border-b-0">
								<button
									onClick={() => setOpen((s) => ({ ...s, [key]: !s[key] }))}
									className="w-full grid grid-cols-[1fr_auto_auto] gap-x-4 px-3 py-1.5 text-[10px] text-left hover:bg-secondary/30 transition-colors cursor-pointer"
									title={`${g.models.length} 个模型 · 共 ${g.count} 次（含失败/进行中）`}
								>
									<span className="flex items-center gap-1 text-foreground truncate">
										{expanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
										<span className="truncate font-semibold">{g.familyName}</span>
										<span className="text-muted-foreground shrink-0">（{g.models.length}）</span>
									</span>
									<span className="text-right w-16 text-foreground font-mono">{g.success.toLocaleString()}</span>
									<span className="text-right w-24 text-foreground font-mono">{g.credits.toLocaleString()}</span>
								</button>
								{expanded && g.models.map((m) => (
									<div key={m.model} className="grid grid-cols-[1fr_auto_auto] gap-x-4 pl-8 pr-3 py-1 text-[10px] bg-secondary/10">
										<span className="text-muted-foreground truncate font-mono" title={m.model}>{m.model}</span>
										<span className="text-right w-16 text-muted-foreground font-mono" title={`共 ${m.count} 次（含失败/进行中）`}>{m.success.toLocaleString()}</span>
										<span className="text-right w-24 text-muted-foreground font-mono">{m.credits.toLocaleString()}</span>
									</div>
								))}
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}

/** 统计明细表（按模型/按步骤共用）：名称 | 成功次数 | 实际消耗积分。
 *  行多时表体内部滚动（上限 ~9 行），避免整个面板被撑得过高。 */
function BreakdownTable({ kind, rows }: { kind: "model" | "purpose"; rows: { key: string; name: string; success: number; count: number; credits: number }[] }) {
	const shown = rows.filter((r) => r.count > 0);
	return (
		<div className="bg-secondary/20 border border-border/20 rounded-lg overflow-hidden">
			<div className="grid grid-cols-[1fr_auto_auto] gap-x-4 px-3 py-1.5 text-[9px] text-muted-foreground border-b border-border/20">
				<span>{kind === "model" ? "模型" : "步骤"}</span>
				<span className="text-right w-16">成功次数</span>
				<span className="text-right w-24">实际消耗积分</span>
			</div>
			{shown.length === 0 ? (
				<div className="text-[10px] text-muted-foreground text-center py-3">该时段暂无消耗</div>
			) : (
				<div className="max-h-[240px] overflow-y-auto Qiji-scroll-thin">
					{shown.map((r) => (
						<div key={r.key} className="grid grid-cols-[1fr_auto_auto] gap-x-4 px-3 py-1.5 text-[10px] border-b border-border/10 last:border-b-0">
							<span className="text-foreground truncate font-mono" title={r.name}>{r.name}</span>
							<span className="text-right w-16 text-foreground font-mono" title={`共 ${r.count} 次（含失败/进行中）`}>{r.success.toLocaleString()}</span>
							<span className="text-right w-24 text-foreground font-mono">{r.credits.toLocaleString()}</span>
						</div>
					))}
				</div>
			)}
		</div>
	);
}

export function PersonalCenter() {
	const setOpen = useUiStore((s) => s.setPersonalCenterOpen);
	const user = useConnectionStore((s) => s.user);
	const setCredits = useConnectionStore((s) => s.setCredits);
	const libtvOn = useLibtvFeature();
	const dreaminaOn = useDreaminaFeature();
	const comfyuiOn = useComfyuiFeature();

	const [stats, setStats] = useState<UserStats | null>(null);
	const [loading, setLoading] = useState(true);
	const [statsErr, setStatsErr] = useState("");

	const [code, setCode] = useState("");
	const [redeeming, setRedeeming] = useState(false);
	const [redeemMsg, setRedeemMsg] = useState<{ ok: boolean; text: string } | null>(null);

	const [bindAcct, setBindAcct] = useState("");
	const [bindPw, setBindPw] = useState("");
	const [binding, setBinding] = useState(false);
	const [bindMsg, setBindMsg] = useState<{ ok: boolean; text: string } | null>(null);

	// 修改密码（登录态自助：校验旧密码；不动 API 密钥——其它设备不掉线）
	const [pwOpen, setPwOpen] = useState(false);
	const [pwOld, setPwOld] = useState("");
	const [pwNew, setPwNew] = useState("");
	const [pwBusy, setPwBusy] = useState(false);
	const [pwMsg, setPwMsg] = useState<{ ok: boolean; text: string } | null>(null);
	const handleChangePw = async (): Promise<void> => {
		if (pwBusy || !pwOld || !pwNew) return;
		if (pwNew.length < 6) { setPwMsg({ ok: false, text: "新密码至少 6 位" }); return; }
		setPwBusy(true);
		setPwMsg(null);
		const r = await managedClient.changePassword(pwOld, pwNew);
		setPwBusy(false);
		if (r.ok) {
			setPwMsg({ ok: true, text: "密码已修改，下次登录使用新密码" });
			setPwOld("");
			setPwNew("");
			setPwOpen(false);
		} else {
			setPwMsg({ ok: false, text: r.error || "修改失败，请稍后重试" });
		}
	};

	// API 密钥（第218轮：accessKey 正名——身份验证与外部 API 对接的唯一凭证）
	const [keyVisible, setKeyVisible] = useState(false);
	const [keyBusy, setKeyBusy] = useState(false);
	const [keyMsg, setKeyMsg] = useState<{ ok: boolean; text: string } | null>(null);
	const apiKey = useConnectionStore((s) => s.accessKey);
	const maskedKey = apiKey ? `${apiKey.slice(0, 6)}${"•".repeat(8)}${apiKey.slice(-4)}` : "—";
	const handleRegenKey = async (): Promise<void> => {
		const ok = await confirmDialog("重置 API 密钥？\n旧密钥立即失效：其它已登录设备与用它对接的外部程序将全部掉线，需换用新密钥。本机无感续用。");
		if (!ok) return;
		setKeyBusy(true);
		setKeyMsg(null);
		const r = await managedClient.regenerateApiKey();
		if (r.ok && r.apiKey) {
			useConnectionStore.getState().setAccessKey(r.apiKey);
			setKeyMsg({ ok: true, text: "已重置——本机已自动换用新密钥，其它设备/对接需更新" });
		} else {
			setKeyMsg({ ok: false, text: r.error || "重置失败，请稍后重试" });
		}
		setKeyBusy(false);
	};

	const [tab, setTab] = useState<"overview" | "logs" | "team" | "stats" | "downloads">("overview");

	// 充值中心（第246轮：会员套餐 / 充值算力 / 兑换码）
	const [rechargeOpen, setRechargeOpen] = useState(false);

	const refresh = async () => {
		setLoading(true);
		setStatsErr("");
		try {
			const s = await managedClient.me();
			setStats(s);
			setCredits(s.credits);
		} catch (e) {
			setStatsErr((e as Error).message || "加载失败");
		} finally {
			setLoading(false);
		}
	};

	useEffect(() => {
		void refresh();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const handleRedeem = async () => {
		const c = code.trim();
		if (!c || redeeming) return;
		setRedeeming(true);
		setRedeemMsg(null);
		const r = await managedClient.redeem(c);
		setRedeeming(false);
		if (r.ok) {
			setRedeemMsg({ ok: true, text: `兑换成功，到账 ${r.added} 积分` });
			setCode("");
			if (typeof r.credits === "number") setCredits(r.credits);
			void refresh();
		} else {
			setRedeemMsg({ ok: false, text: r.error || "兑换失败" });
		}
	};

	const handleBind = async () => {
		const a = bindAcct.trim();
		if (!a || !bindPw || binding) return;
		if (bindPw.length < 6) { setBindMsg({ ok: false, text: "密码至少 6 位" }); return; }
		setBinding(true);
		setBindMsg(null);
		const r = await managedClient.bindAccount(a, bindPw);
		setBinding(false);
		if (r.ok) {
			setBindMsg({ ok: true, text: `账号 ${r.account} 绑定成功，下次可用账号密码登录` });
			setBindPw("");
			void refresh();
		} else {
			setBindMsg({ ok: false, text: r.error || "绑定失败" });
		}
	};

	const [signingOut, setSigningOut] = useState(false);

	/** 退出账号：确认 → 尽力保存当前项目 → 清除本机 accessKey（防止重启自动回登）→ 登出回登录页（account 保留供登录页预填） */
	const handleSignOut = async () => {
		if (signingOut) return;
		const ok = await confirmDialog("退出当前账号并返回登录页？\n本机项目文件保留，下次可用账号密码重新登录。");
		if (!ok) return;
		setSigningOut(true);
		try {
			const ps = useProjectStore.getState();
			if (ps.savePath) await ps.save();
		} catch {
			/* 保存失败不阻断退出（自动保存兜底） */
		}
		const conn = useConnectionStore.getState();
		conn.setAccessKey("");
		conn.setSession(false, null);
	};

	const credits = stats?.credits ?? user?.credits ?? 0;

	const Stat = ({ label, value }: { label: string; value: number | string }) => (
		<div className="flex flex-col gap-1 bg-secondary/30 border border-border/30 rounded-lg px-4 py-3">
			<span className="text-[10px] text-muted-foreground">{label}</span>
			<span className="text-sm font-semibold text-foreground font-mono">{value}</span>
		</div>
	);

	return (
		<div
			className="fixed inset-0 z-[20000] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-200"
			onClick={() => setOpen(false)}
		>
			<div
				className={`Qiji-panel flex flex-col ${tab === "logs" ? "w-[720px]" : tab === "downloads" ? "w-[640px]" : tab === "team" || tab === "stats" ? "w-[560px]" : "w-[440px]"} max-h-[85vh] rounded-2xl text-foreground shadow-2xl overflow-hidden relative transition-[width] duration-200`}
				style={{ border: "1px solid rgba(255, 255, 255, 0.1)" }}
				onClick={(e) => e.stopPropagation()}
			>
				{/* Header */}
				<div className="flex items-center justify-between px-6 pt-5 pb-0">
					<div>
						<div className="flex items-center gap-2">
							<UserCircle className="h-4 w-4 text-primary" />
							<h3 className="text-sm font-semibold text-foreground">个人中心</h3>
						</div>
						<p className="text-[10px] text-muted-foreground mt-0.5">{user?.name ?? "未登录"} · 积分与兑换</p>
					</div>
					<button
						onClick={() => setOpen(false)}
						className="text-muted-foreground hover:text-foreground hover:bg-secondary rounded-lg p-1 transition-colors cursor-pointer"
					>
						<X className="h-4 w-4" />
					</button>
				</div>

				{/* 页签：概览 / 请求记录（本人任务提交与积分扣退，详情仅 ①② 段） */}
				<div className="flex items-center gap-1 px-6 pt-3">
					<button
						onClick={() => setTab("overview")}
						className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] cursor-pointer transition-colors ${tab === "overview" ? "bg-primary/20 text-foreground font-semibold" : "text-muted-foreground hover:text-foreground"}`}
					>
						<Coins className="h-3 w-3" /> 概览
					</button>
					<button
						onClick={() => setTab("team")}
						className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] cursor-pointer transition-colors ${tab === "team" ? "bg-primary/20 text-foreground font-semibold" : "text-muted-foreground hover:text-foreground"}`}
					>
						<Users className="h-3 w-3" /> 团队
					</button>
					<button
						onClick={() => setTab("stats")}
						className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] cursor-pointer transition-colors ${tab === "stats" ? "bg-primary/20 text-foreground font-semibold" : "text-muted-foreground hover:text-foreground"}`}
					>
						<BarChart3 className="h-3 w-3" /> 统计
					</button>
					<button
						onClick={() => setTab("logs")}
						className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] cursor-pointer transition-colors ${tab === "logs" ? "bg-primary/20 text-foreground font-semibold" : "text-muted-foreground hover:text-foreground"}`}
					>
						<ListOrdered className="h-3 w-3" /> 请求记录
					</button>
					{isTauri() && (
						<button
							onClick={() => setTab("downloads")}
							className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] cursor-pointer transition-colors ${tab === "downloads" ? "bg-primary/20 text-foreground font-semibold" : "text-muted-foreground hover:text-foreground"}`}
						>
							<Download className="h-3 w-3" /> 批量下载
						</button>
					)}
				</div>

				{tab === "logs" ? (
					<div className="flex-1 overflow-y-auto px-6 py-4 Qiji-scroll-thin">
						<LogsSection />
					</div>
				) : tab === "team" ? (
					<div className="flex-1 overflow-y-auto px-6 py-4 Qiji-scroll-thin">
						<TeamSection onChanged={() => void refresh()} />
					</div>
				) : tab === "stats" ? (
					<div className="flex-1 overflow-y-auto px-6 py-4 Qiji-scroll-thin">
						<StatsSection />
					</div>
				) : tab === "downloads" ? (
					<div className="flex-1 overflow-y-auto px-6 py-4 Qiji-scroll-thin">
						<DownloadsSection />
					</div>
				) : (
				<div className="flex-1 overflow-y-auto px-6 py-5 Qiji-scroll-thin flex flex-col gap-5">
					{/* 余额 */}
					<div className="bg-gradient-to-br from-primary/20 to-primary/5 border border-primary/30 rounded-xl px-5 py-4 flex items-center justify-between">
						<div className="flex flex-col gap-1">
							<span className="text-[10px] text-muted-foreground flex items-center gap-1">
								<Coins className="h-3 w-3" />
								{stats?.team?.creditMode === "shared" && stats.team.role === "member" ? "团队共享积分（池）" : "当前积分余额"}
							</span>
							<span className="text-2xl font-bold text-foreground font-mono">{credits}</span>
							{stats?.team?.creditMode === "shared" && stats.team.role === "member" && (
								<span className="text-[9px] text-muted-foreground">
									团队「{stats.team.name}」共享池（消耗扣团长积分）· 我的个人积分 {stats.ownCredits ?? 0}
								</span>
							)}
						</div>
						<div className="flex items-center gap-1.5">
							<button
								onClick={() => setRechargeOpen(true)}
								className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-[11px] font-semibold hover:bg-primary/90 transition-colors cursor-pointer"
								title="会员套餐 / 充值算力 / 兑换码"
							>
								<Coins className="h-3.5 w-3.5" /> 充值中心
							</button>
							<button
								onClick={refresh}
								disabled={loading}
								className="text-muted-foreground hover:text-foreground rounded-lg p-1.5 transition-colors cursor-pointer disabled:opacity-50"
								title="刷新"
							>
								{loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
							</button>
						</div>
					</div>

					{/* 会员状态（第246轮）：生效中显示到期与折扣，未开通显示引导横幅 */}
					{stats?.membership ? (
						<div className="flex items-center gap-2 bg-primary/10 border border-primary/30 rounded-lg px-4 py-2.5">
							<Crown className="h-3.5 w-3.5 text-primary shrink-0" />
							<span className="text-[11px] text-foreground">
								<b>{stats.membership.planName}</b> 生效中 · 至 <span className="font-mono">{stats.membership.expiresAt.slice(0, 10)}</span>
								{stats.membership.discountPercent < 100 && <> · 生成计费 <b>{discountLabel(stats.membership.discountPercent)}</b></>}
							</span>
							<button
								onClick={() => setRechargeOpen(true)}
								className="ml-auto shrink-0 px-2 py-1 rounded-md bg-secondary/50 border border-border/40 text-[10px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
							>
								续费
							</button>
						</div>
					) : (
						<button
							onClick={() => setRechargeOpen(true)}
							className="flex items-center gap-2 bg-secondary/30 border border-border/30 rounded-lg px-4 py-2.5 hover:border-primary/40 transition-colors cursor-pointer text-left"
						>
							<Sparkles className="h-3.5 w-3.5 text-primary shrink-0" />
							<span className="text-[11px] text-muted-foreground">开通会员 · 享生成折扣与到账算力</span>
							<span className="ml-auto text-[10px] text-primary shrink-0">查看套餐 →</span>
						</button>
					)}

					{statsErr && <div className="text-[10px] text-destructive">{statsErr}</div>}

					{/* 消耗统计 */}
					<div className="grid grid-cols-2 gap-3">
						<Stat label="当日消耗" value={stats?.dailySpent ?? "—"} />
						<Stat label="累计消耗" value={stats?.totalSpent ?? "—"} />
					</div>

					{/* 我的邀请码（P2b）：好友注册时填写即记录邀请关系 */}
					{stats?.inviteCode && (
						<div className="flex items-center gap-2 bg-secondary/30 border border-border/30 rounded-lg px-4 py-2.5">
							<span className="text-[11px] text-muted-foreground shrink-0">我的邀请码</span>
							<span
								className="text-[12px] font-mono text-foreground cursor-pointer hover:text-primary"
								title="点击复制，发给好友注册时填写"
								onClick={() => navigator.clipboard?.writeText(stats.inviteCode!)}
							>
								{stats.inviteCode}
							</span>
							<span className="text-[10px] text-muted-foreground ml-auto shrink-0">已邀请 {stats.invitedCount ?? 0} 人</span>
						</div>
					)}

					{/* 登录账号：已绑定则展示，未绑定则可绑定（管理端手工建号的用户在此设账号密码） */}
					<div className="flex flex-col gap-2">
						<div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
							<UserCircle className="h-3.5 w-3.5 text-primary" /> 登录账号
						</div>
						{stats?.account ? (
							<>
								<div className="flex items-center gap-2 bg-secondary/30 border border-border/30 rounded-lg px-4 py-3">
									<CheckCircle className="h-3.5 w-3.5 text-green-400" />
									<span className="text-[11px] text-foreground font-mono">{stats.account}</span>
									<span className="text-[10px] text-muted-foreground">已绑定，可用账号密码登录</span>
									<button
										onClick={() => { setPwOpen((v) => !v); setPwMsg(null); }}
										className="ml-auto shrink-0 px-2 py-1 rounded-md bg-secondary/50 border border-border/40 text-[10px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
									>
										{pwOpen ? "收起" : "修改密码"}
									</button>
								</div>
								{pwOpen && (
									<div className="flex items-center gap-2">
										<input
											type="password"
											value={pwOld}
											onChange={(e) => setPwOld(e.target.value)}
											placeholder="当前密码"
											autoComplete="current-password"
											className="flex-1 bg-secondary/40 border border-border/40 rounded-lg px-3 py-2 text-[11px] font-mono text-foreground outline-none focus:border-primary/60"
										/>
										<input
											type="password"
											value={pwNew}
											onChange={(e) => setPwNew(e.target.value)}
											onKeyDown={(e) => { if (e.key === "Enter") void handleChangePw(); }}
											placeholder="新密码 ≥6 位"
											autoComplete="new-password"
											className="flex-1 bg-secondary/40 border border-border/40 rounded-lg px-3 py-2 text-[11px] font-mono text-foreground outline-none focus:border-primary/60"
										/>
										<button
											onClick={() => void handleChangePw()}
											disabled={pwBusy || !pwOld || !pwNew}
											className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary text-primary-foreground font-semibold hover:bg-primary/90 transition-colors cursor-pointer text-[11px] disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
										>
											{pwBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <KeyRound className="h-3.5 w-3.5" />}
											确认修改
										</button>
									</div>
								)}
								{pwMsg && (
									<span className={`flex items-center gap-1 text-[10px] ${pwMsg.ok ? "text-green-400" : "text-destructive"}`}>
										{pwMsg.ok ? <CheckCircle className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
										{pwMsg.text}
									</span>
								)}
							</>
						) : (
							<>
								<div className="text-[10px] text-muted-foreground">
									绑定账号后可用「账号 + 密码」登录。
								</div>
								<div className="flex items-center gap-2">
									<input
										value={bindAcct}
										onChange={(e) => setBindAcct(e.target.value)}
										placeholder="账号 3–32 位"
										autoComplete="username"
										className="flex-1 bg-secondary/40 border border-border/40 rounded-lg px-3 py-2 text-[11px] font-mono text-foreground outline-none focus:border-primary/60"
									/>
									<input
										type="password"
										value={bindPw}
										onChange={(e) => setBindPw(e.target.value)}
										onKeyDown={(e) => { if (e.key === "Enter") void handleBind(); }}
										placeholder="密码 ≥6 位"
										autoComplete="new-password"
										className="flex-1 bg-secondary/40 border border-border/40 rounded-lg px-3 py-2 text-[11px] font-mono text-foreground outline-none focus:border-primary/60"
									/>
									<button
										onClick={handleBind}
										disabled={binding || !bindAcct.trim() || !bindPw}
										className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary text-primary-foreground font-semibold hover:bg-primary/90 transition-colors cursor-pointer text-[11px] disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
									>
										{binding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserCircle className="h-3.5 w-3.5" />}
										绑定
									</button>
								</div>
							</>
						)}
						{bindMsg && (
							<span className={`flex items-center gap-1 text-[10px] ${bindMsg.ok ? "text-green-400" : "text-destructive"}`}>
								{bindMsg.ok ? <CheckCircle className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
								{bindMsg.text}
							</span>
						)}
					</div>

					{/* API 密钥（第218轮）：身份验证与外部 API 对接的唯一凭证；机器码已退役 */}
					<div className="flex flex-col gap-2">
						<div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
							<KeyRound className="h-3.5 w-3.5 text-primary" /> API 密钥
						</div>
						<div className="flex items-center gap-2 bg-secondary/30 border border-border/30 rounded-lg px-4 py-2.5">
							<span className="text-[11px] font-mono text-foreground select-all" title="身份凭证：客户端登录与外部 API 对接共用（Authorization: Bearer）">
								{keyVisible ? apiKey : maskedKey}
							</span>
							<span className="ml-auto shrink-0 flex items-center gap-1.5">
								<button
									onClick={() => setKeyVisible((v) => !v)}
									className="px-2 py-1 rounded-md bg-secondary/50 border border-border/40 text-[10px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
								>
									{keyVisible ? "隐藏" : "显示"}
								</button>
								<button
									onClick={() => { void navigator.clipboard?.writeText(apiKey); setKeyMsg({ ok: true, text: "已复制到剪贴板" }); }}
									className="px-2 py-1 rounded-md bg-secondary/50 border border-border/40 text-[10px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
								>
									复制
								</button>
								<button
									onClick={() => void handleRegenKey()}
									disabled={keyBusy}
									className="px-2 py-1 rounded-md bg-destructive/15 border border-destructive/30 text-[10px] text-destructive hover:bg-destructive/25 transition-colors cursor-pointer disabled:opacity-50"
								>
									{keyBusy ? "重置中…" : "重置"}
								</button>
							</span>
						</div>
						<div className="text-[10px] text-muted-foreground">
							用于身份验证与 API 对接（请求头 <span className="font-mono">Authorization: Bearer &lt;密钥&gt;</span>）。请妥善保管；泄露可「重置」换新，旧密钥立即失效。
						</div>
						{keyMsg && (
							<span className={`flex items-center gap-1 text-[10px] ${keyMsg.ok ? "text-green-400" : "text-destructive"}`}>
								{keyMsg.ok ? <CheckCircle className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
								{keyMsg.text}
							</span>
						)}
					</div>

					{/* 兑换码 */}
					<div className="flex flex-col gap-2">
						<div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
							<Gift className="h-3.5 w-3.5 text-primary" /> 兑换积分码
						</div>
						<div className="flex items-center gap-2">
							<input
								value={code}
								onChange={(e) => setCode(e.target.value)}
								onKeyDown={(e) => { if (e.key === "Enter") void handleRedeem(); }}
								placeholder="输入兑换码，如 QJ-XXXX-XXXX-XXXX"
								className="flex-1 bg-secondary/40 border border-border/40 rounded-lg px-3 py-2 text-[11px] font-mono text-foreground outline-none focus:border-primary/60"
							/>
							<button
								onClick={handleRedeem}
								disabled={redeeming || !code.trim()}
								className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary text-primary-foreground font-semibold hover:bg-primary/90 transition-colors cursor-pointer text-[11px] disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
							>
								{redeeming ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Gift className="h-3.5 w-3.5" />}
								兑换
							</button>
						</div>
						{redeemMsg && (
							<span className={`flex items-center gap-1 text-[10px] ${redeemMsg.ok ? "text-green-400" : "text-destructive"}`}>
								{redeemMsg.ok ? <CheckCircle className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
								{redeemMsg.text}
							</span>
						)}
					</div>

					{/* LibTV 授权（桌面端 + 管理端开放该入口时） */}
					{libtvOn && isTauri() && <LibtvSection />}

					{/* 即梦授权（桌面端 + 管理端开放该入口时） */}
					{dreaminaOn && isTauri() && <DreaminaSection />}

					{/* ComfyUI 直连（管理端开放该入口时；不限桌面端——浏览器 dev 需 ComfyUI 开 CORS，区块内有提示） */}
					{comfyuiOn && <ComfyuiSection />}
				</div>
				)}

				{/* Footer：左=退出账号（清除本机凭证回登录页），中=客户端版本标识（排查构建用），右=完成 */}
				<div className="flex items-center justify-between gap-2 px-6 py-4 border-t border-border/40">
					<button
						onClick={() => void handleSignOut()}
						disabled={signingOut}
						className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-destructive/10 border border-destructive/30 text-destructive hover:bg-destructive/20 font-semibold cursor-pointer transition-colors text-xs disabled:opacity-50 disabled:cursor-not-allowed"
					>
						{signingOut ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <LogOut className="h-3.5 w-3.5" />}
						退出账号
					</button>
					<span className="text-[10px] text-muted-foreground/70 select-text" title="客户端版本 · 构建时间（区分新旧构建）">
						{versionLabel()}
					</span>
					<button
						onClick={() => setOpen(false)}
						className="px-5 py-2 rounded-lg bg-secondary text-foreground hover:bg-secondary/80 font-semibold cursor-pointer transition-colors text-xs"
					>
						完成
					</button>
				</div>
			</div>

			{/* 充值中心（第246轮）：会员套餐 / 充值算力 / 兑换码 */}
			<RechargeCenter open={rechargeOpen} onClose={() => setRechargeOpen(false)} onChanged={() => void refresh()} />
		</div>
	);
}
