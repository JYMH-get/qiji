/**
 * 充值中心（第246轮，参考竞品充值中心布局）：会员套餐 / 充值算力 / 兑换码 三页签。
 *
 * v1 定稿（用户拍板）：
 *  - 会员=单档，开通方式=**会员卡兑换码**（仅源站签发；真实支付未接入，支付位仅预留展示）；
 *  - 权益=开通即到账算力（积分）+ 会员期内生成计费折扣（折扣在服务端实扣时生效，
 *    客户端各处预估仍显示标准价——折后实扣 ≤ 预估，保守安全）；
 *  - 「兑换码」页签=统一入口，按前缀自动识别：mc-会员卡 / sc-扩容卡 / 其余=积分兑换码。
 */
import { useEffect, useState } from "react";
import { X, Crown, Coins, Gift, Loader2, CheckCircle, XCircle, Sparkles, BadgeCheck, CreditCard } from "lucide-react";
import { managedClient } from "@/services/managedClient";
import { useConnectionStore } from "@/store/connectionStore";
import type { MembershipInfo, MembershipPlanInfo } from "@/contract";

/** 95 → 「9.5 折」；100 → 「无折扣」 */
export function discountLabel(pct: number): string {
	if (!Number.isFinite(pct) || pct >= 100) return "无折扣";
	const zhe = pct / 10;
	return `${(Math.round(zhe * 10) / 10).toString().replace(/\.0$/, "")} 折`;
}

type TabKey = "plan" | "credits" | "redeem";

export function RechargeCenter({ open, onClose, onChanged }: { open: boolean; onClose: () => void; onChanged?: () => void }): React.ReactElement | null {
	const credits = useConnectionStore((s) => s.user?.credits ?? 0);
	const setCredits = useConnectionStore((s) => s.setCredits);

	const [tab, setTab] = useState<TabKey>("plan");
	const [plan, setPlan] = useState<MembershipPlanInfo | null>(null);
	const [membership, setMembership] = useState<MembershipInfo | null>(null);
	const [loading, setLoading] = useState(false);

	const [cardCode, setCardCode] = useState("");
	const [cardBusy, setCardBusy] = useState(false);
	const [cardMsg, setCardMsg] = useState<{ ok: boolean; text: string } | null>(null);

	const [creditCode, setCreditCode] = useState("");
	const [creditBusy, setCreditBusy] = useState(false);
	const [creditMsg, setCreditMsg] = useState<{ ok: boolean; text: string } | null>(null);

	const [anyCode, setAnyCode] = useState("");
	const [anyBusy, setAnyBusy] = useState(false);
	const [anyMsg, setAnyMsg] = useState<{ ok: boolean; text: string } | null>(null);

	useEffect(() => {
		if (!open) return;
		setLoading(true);
		void managedClient.getMembership().then((r) => {
			setPlan(r.plan ?? null);
			setMembership(r.membership ?? null);
			setLoading(false);
		});
	}, [open]);

	if (!open) return null;

	/** 核销会员卡（会员套餐页与统一兑换页共用） */
	const redeemCard = async (code: string): Promise<{ ok: boolean; text: string }> => {
		const r = await managedClient.redeemMembershipCard(code);
		if (!r.ok) return { ok: false, text: r.error || "核销失败" };
		if (typeof r.credits === "number") setCredits(r.credits);
		if (r.membership) setMembership(r.membership);
		onChanged?.();
		const until = r.membership ? r.membership.expiresAt.slice(0, 10) : "";
		return { ok: true, text: `会员已开通${until ? `，有效期至 ${until}` : ""}${r.added ? `，到账 ${r.added.toLocaleString()} 积分` : ""}` };
	};

	/** 兑换积分码 */
	const redeemCredits = async (code: string): Promise<{ ok: boolean; text: string }> => {
		const r = await managedClient.redeem(code);
		if (!r.ok) return { ok: false, text: r.error || "兑换失败" };
		if (typeof r.credits === "number") setCredits(r.credits);
		onChanged?.();
		return { ok: true, text: `兑换成功，到账 ${r.added ?? 0} 积分` };
	};

	/** 扩容卡 */
	const redeemStorage = async (code: string): Promise<{ ok: boolean; text: string }> => {
		try {
			await managedClient.redeemStorageCode(code);
			onChanged?.();
			return { ok: true, text: "扩容卡已核销，收藏空间已提升" };
		} catch (err) {
			return { ok: false, text: (err as Error).message || "核销失败" };
		}
	};

	const handleCard = async (): Promise<void> => {
		const c = cardCode.trim();
		if (!c || cardBusy) return;
		setCardBusy(true);
		setCardMsg(null);
		const r = await redeemCard(c);
		setCardBusy(false);
		setCardMsg(r);
		if (r.ok) setCardCode("");
	};

	const handleCredits = async (): Promise<void> => {
		const c = creditCode.trim();
		if (!c || creditBusy) return;
		setCreditBusy(true);
		setCreditMsg(null);
		const r = await redeemCredits(c);
		setCreditBusy(false);
		setCreditMsg(r);
		if (r.ok) setCreditCode("");
	};

	/** 统一兑换：按前缀识别 mc-/sc-，其余走积分兑换码 */
	const handleAny = async (): Promise<void> => {
		const c = anyCode.trim();
		if (!c || anyBusy) return;
		setAnyBusy(true);
		setAnyMsg(null);
		const lower = c.toLowerCase();
		const r = lower.startsWith("mc-") ? await redeemCard(c) : lower.startsWith("sc-") ? await redeemStorage(c) : await redeemCredits(c);
		setAnyBusy(false);
		setAnyMsg(r);
		if (r.ok) setAnyCode("");
	};

	const benefits: string[] = [];
	if (plan) {
		if (plan.credits > 0) benefits.push(`开通即到账 ${plan.credits.toLocaleString()} 算力（积分）`);
		if (plan.discountPercent < 100) benefits.push(`会员期内生成计费 ${discountLabel(plan.discountPercent)}`);
		benefits.push(`权益有效期 ${plan.days} 天（未过期续费自动顺延）`);
		for (const line of (plan.benefitsNote ?? "").split("\n")) {
			const t = line.trim();
			if (t && !benefits.includes(t)) benefits.push(t);
		}
	}

	const inputCls = "flex-1 bg-secondary/40 border border-border/40 rounded-lg px-3 py-2 text-[11px] font-mono text-foreground outline-none focus:border-primary/60";
	const btnCls = "flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary text-primary-foreground font-semibold hover:bg-primary/90 transition-colors cursor-pointer text-[11px] disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap";
	const msgView = (m: { ok: boolean; text: string } | null): React.ReactElement | null =>
		m ? (
			<span className={`flex items-center gap-1 text-[10px] ${m.ok ? "text-green-400" : "text-destructive"}`}>
				{m.ok ? <CheckCircle className="h-3 w-3 shrink-0" /> : <XCircle className="h-3 w-3 shrink-0" />}
				{m.text}
			</span>
		) : null;

	return (
		<div className="fixed inset-0 z-[100480] flex items-center justify-center" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
			<div className="absolute inset-0 bg-black/60" />
			<div className="Qiji-panel relative w-[720px] max-w-[94vw] max-h-[85vh] rounded-2xl text-foreground shadow-2xl overflow-hidden flex flex-col">
				{/* 头部 */}
				<div className="flex items-center gap-3 px-6 py-4 border-b border-border/40">
					<Crown className="h-4 w-4 text-primary" />
					<div className="flex flex-col">
						<span className="text-sm font-bold">充值中心</span>
						<span className="text-[10px] text-muted-foreground">当前余额：<b className="text-foreground font-mono">{credits.toLocaleString()}</b> 积分</span>
					</div>
					<button onClick={onClose} className="ml-auto text-muted-foreground hover:text-foreground rounded-lg p-1.5 transition-colors cursor-pointer" title="关闭">
						<X className="h-4 w-4" />
					</button>
				</div>

				{/* 页签 */}
				<div className="flex items-center gap-1 px-6 pt-3">
					{([["plan", "会员套餐"], ["credits", "充值算力"], ["redeem", "兑换码"]] as [TabKey, string][]).map(([k, label]) => (
						<button
							key={k}
							onClick={() => setTab(k)}
							className={`px-4 py-1.5 rounded-lg text-[11px] cursor-pointer transition-colors ${tab === k ? "bg-primary/20 text-foreground font-semibold" : "text-muted-foreground hover:text-foreground"}`}
						>
							{label}
						</button>
					))}
				</div>

				<div className="flex-1 overflow-y-auto px-6 py-4">
					{tab === "plan" && (
						<div className="flex flex-col gap-3">
							{/* 我的会员状态 */}
							<div className={`flex items-center gap-2 rounded-xl px-4 py-3 border ${membership ? "bg-primary/10 border-primary/30" : "bg-secondary/30 border-border/30"}`}>
								{membership ? (
									<>
										<BadgeCheck className="h-4 w-4 text-primary shrink-0" />
										<span className="text-[11px]">
											<b>{membership.planName}</b> 生效中 · 有效期至 <b className="font-mono">{membership.expiresAt.slice(0, 10)}</b>
											{membership.discountPercent < 100 && <> · 生成计费 <b>{discountLabel(membership.discountPercent)}</b></>}
										</span>
									</>
								) : (
									<>
										<Sparkles className="h-4 w-4 text-primary shrink-0" />
										<span className="text-[11px] text-muted-foreground">尚未开通会员——开通后享生成折扣与到账算力</span>
									</>
								)}
							</div>

							{loading ? (
								<div className="flex items-center gap-2 text-[11px] text-muted-foreground py-8 justify-center">
									<Loader2 className="h-4 w-4 animate-spin" /> 加载中…
								</div>
							) : !plan ? (
								<div className="text-[11px] text-muted-foreground py-8 text-center">会员套餐暂未开放，请联系管理员或你的服务商。</div>
							) : (
								<div className="flex gap-3">
									{/* 套餐卡 */}
									<div className="flex-1 rounded-xl border border-primary/40 bg-primary/5 p-4 flex flex-col gap-2">
										<div className="flex items-center gap-2">
											<Crown className="h-4 w-4 text-primary" />
											<span className="text-sm font-bold">{plan.name}</span>
											{plan.priceLabel && <span className="ml-auto text-lg font-bold text-primary font-mono">{plan.priceLabel}</span>}
										</div>
										<div className="h-px bg-border/40 my-1" />
										<ul className="flex flex-col gap-1.5">
											{benefits.map((b, i) => (
												<li key={i} className="flex items-start gap-1.5 text-[11px] text-foreground/90">
													<CheckCircle className="h-3 w-3 text-primary shrink-0 mt-0.5" />
													{b}
												</li>
											))}
										</ul>
									</div>
									{/* 开通方式 */}
									<div className="w-[280px] shrink-0 rounded-xl border border-border/30 bg-secondary/20 p-4 flex flex-col gap-2.5">
										<span className="text-[11px] font-semibold flex items-center gap-1.5"><Gift className="h-3.5 w-3.5 text-primary" /> 会员卡开通</span>
										<div className="flex items-center gap-2">
											<input
												value={cardCode}
												onChange={(e) => setCardCode(e.target.value)}
												onKeyDown={(e) => { if (e.key === "Enter") void handleCard(); }}
												placeholder="输入会员卡号 mc-…"
												className={inputCls}
											/>
										</div>
										<button onClick={() => void handleCard()} disabled={cardBusy || !cardCode.trim()} className={`${btnCls} justify-center`}>
											{cardBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Crown className="h-3.5 w-3.5" />}
											{membership ? "续费会员" : "立即开通"}
										</button>
										{msgView(cardMsg)}
										<div className="text-[10px] text-muted-foreground leading-relaxed">
											会员卡请联系管理员或你的服务商获取。{membership ? "未到期续费自动顺延。" : ""}
										</div>
										<div className="h-px bg-border/40" />
										<button disabled className="flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-secondary/40 border border-border/40 text-[11px] text-muted-foreground/60 cursor-not-allowed" title="在线支付暂未开放">
											<CreditCard className="h-3.5 w-3.5" /> 在线支付（即将开放）
										</button>
									</div>
								</div>
							)}
						</div>
					)}

					{tab === "credits" && (
						<div className="flex flex-col gap-3">
							<div className="rounded-xl border border-border/30 bg-secondary/20 px-4 py-4 flex items-center gap-3">
								<Coins className="h-5 w-5 text-primary shrink-0" />
								<div className="flex flex-col">
									<span className="text-[10px] text-muted-foreground">当前算力（积分）</span>
									<span className="text-2xl font-bold font-mono">{credits.toLocaleString()}</span>
								</div>
							</div>
							<div className="rounded-xl border border-border/30 bg-secondary/20 p-4 flex flex-col gap-2.5">
								<span className="text-[11px] font-semibold flex items-center gap-1.5"><Gift className="h-3.5 w-3.5 text-primary" /> 兑换积分码充值</span>
								<div className="flex items-center gap-2">
									<input
										value={creditCode}
										onChange={(e) => setCreditCode(e.target.value)}
										onKeyDown={(e) => { if (e.key === "Enter") void handleCredits(); }}
										placeholder="输入兑换码，如 QJ-XXXX-XXXX-XXXX"
										className={inputCls}
									/>
									<button onClick={() => void handleCredits()} disabled={creditBusy || !creditCode.trim()} className={btnCls}>
										{creditBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Gift className="h-3.5 w-3.5" />}
										兑换
									</button>
								</div>
								{msgView(creditMsg)}
								<div className="text-[10px] text-muted-foreground">在线充值暂未开放——兑换码请联系管理员或你的服务商获取。</div>
							</div>
						</div>
					)}

					{tab === "redeem" && (
						<div className="flex flex-col gap-3">
							<div className="rounded-xl border border-border/30 bg-secondary/20 p-4 flex flex-col gap-2.5">
								<span className="text-[11px] font-semibold flex items-center gap-1.5"><Gift className="h-3.5 w-3.5 text-primary" /> 统一兑换</span>
								<div className="flex items-center gap-2">
									<input
										value={anyCode}
										onChange={(e) => setAnyCode(e.target.value)}
										onKeyDown={(e) => { if (e.key === "Enter") void handleAny(); }}
										placeholder="输入任意兑换码：会员卡 / 扩容卡 / 积分兑换码"
										className={inputCls}
									/>
									<button onClick={() => void handleAny()} disabled={anyBusy || !anyCode.trim()} className={btnCls}>
										{anyBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Gift className="h-3.5 w-3.5" />}
										兑换
									</button>
								</div>
								{msgView(anyMsg)}
								<div className="text-[10px] text-muted-foreground leading-relaxed">
									自动识别类型：<span className="font-mono">mc-</span> 开头=会员卡（开通/续费会员）；<span className="font-mono">sc-</span> 开头=扩容卡（提升收藏空间，团队卡请到「团队」页由团长使用）；其余=积分兑换码（直接到账）。
								</div>
							</div>
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
