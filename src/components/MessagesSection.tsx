import { useEffect, useRef, useState } from "react";
import { Bell, CheckCheck, ChevronDown, ChevronRight, Loader2, RefreshCw } from "lucide-react";
import type { UserMessage } from "@/contract";
import { managedClient } from "@/services/managedClient";
import { useConnectionStore } from "@/store/connectionStore";
import { useUiStore } from "@/store/uiStore";

const UPDATED = "qiji:messages-updated";
function useMessageIdentity() {
	const server = useConnectionStore(s => s.serverUrl);
	const key = useConnectionStore(s => s.accessKey);
	const userId = useConnectionStore(s => s.user?.id);
	const audience = useConnectionStore(s => s.user?.catalogAudience);
	return { identity: `${server}\n${key}\n${userId || ""}\n${audience || ""}`, active: !!key && !!userId };
}

/** 静默刷新未读数；账号变化时旧请求和旧徽标均不再可见。 */
export function MessageCenterButton() {
	const { identity, active } = useMessageIdentity();
	const [state, setState] = useState({ identity: "", unread: 0 });
	useEffect(() => {
		let stopped = false, loading = false;
		const refresh = async () => {
			if (!active || loading || document.hidden) return;
			loading = true;
			try { const r = await managedClient.getMessages(); if (!stopped) setState({ identity, unread: r.unread }); }
			catch { /* 消息暂不可用不打断创作。 */ }
			finally { loading = false; }
		};
		setState({ identity, unread: 0 });
		void refresh();
		const timer = window.setInterval(() => void refresh(), 60_000);
		window.addEventListener(UPDATED, refresh);
		document.addEventListener("visibilitychange", refresh);
		return () => { stopped = true; window.clearInterval(timer); window.removeEventListener(UPDATED, refresh); document.removeEventListener("visibilitychange", refresh); };
	}, [identity, active]);
	const unread = state.identity === identity ? state.unread : 0;
	if (!active) return null;
	return <button type="button" onClick={() => useUiStore.getState().openPersonalCenterTab("messages")}
		className="relative flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] text-muted-foreground hover:bg-secondary/60 hover:text-foreground transition-colors cursor-pointer"
		aria-label={unread ? `消息，${unread} 条未读` : "消息"} title="消息">
		<Bell className="h-3.5 w-3.5" /><span>消息</span>
		{unread > 0 && <span className="min-w-4 rounded-full bg-primary px-1 py-0.5 text-center text-[9px] leading-none text-primary-foreground">{unread > 99 ? "99+" : unread}</span>}
	</button>;
}

export function MessagesSection() {
	const { identity, active } = useMessageIdentity();
	const [state, setState] = useState<{ identity: string; items: UserMessage[]; total: number; unread: number }>({ identity: "", items: [], total: 0, unread: 0 });
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState("");
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const [marking, setMarking] = useState(false);
	const version = useRef(0);
	const latestIdentity = useRef(identity);
	latestIdentity.current = identity;
	const items = state.identity === identity ? state.items : [];
	const current = state.identity === identity;
	async function load(append = false) {
		const request = ++version.current, owner = identity;
		if (!active) return;
		setLoading(true); setError("");
		try {
			const result = await managedClient.getMessages(append ? items.length : 0);
			if (request !== version.current || latestIdentity.current !== owner) return;
			setState(s => ({ identity: owner, items: append && s.identity === owner ? [...s.items, ...result.items.filter(m => !s.items.some(x => x.id === m.id))] : result.items, total: result.total, unread: result.unread }));
		} catch (e) { if (request === version.current && latestIdentity.current === owner) setError((e as Error).message || "消息加载失败"); }
		finally { if (request === version.current && latestIdentity.current === owner) setLoading(false); }
	}
	useEffect(() => {
		setState({ identity, items: [], total: 0, unread: 0 }); setExpanded(new Set()); setError(""); setMarking(false);
		void load();
		return () => { version.current++; };
		// The identity is the boundary of this request list.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [identity, active]);
	async function mark(id?: string) {
		const owner = identity; version.current++; setLoading(false); setMarking(true); setError("");
		try {
			const result = await managedClient.readMessages(id);
			if (latestIdentity.current !== owner) return;
			setState(s => ({ ...s, items: s.items.map(m => !id || m.id === id ? { ...m, read: true } : m), unread: result.unread }));
			window.dispatchEvent(new Event(UPDATED));
		} catch (e) { if (latestIdentity.current === owner) setError((e as Error).message || "更新消息状态失败"); }
		finally { if (latestIdentity.current === owner) setMarking(false); }
	}
	function toggle(message: UserMessage) {
		setExpanded(previous => { const next = new Set(previous); if (next.has(message.id)) next.delete(message.id); else next.add(message.id); return next; });
		if (!message.read && !marking) void mark(message.id);
	}
	return <section className="flex flex-col gap-3" aria-label="消息列表">
		<div className="flex items-center gap-2 text-[11px]">
			<span className="text-muted-foreground">{current ? state.unread : 0} 条未读</span><span className="flex-1" />
			<button type="button" onClick={() => void load()} disabled={loading || marking} className="flex items-center gap-1 rounded-lg px-2 py-1.5 hover:bg-secondary disabled:opacity-50"><RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />刷新</button>
			<button type="button" onClick={() => void mark()} disabled={marking || !current || state.unread === 0} className="flex items-center gap-1 rounded-lg px-2 py-1.5 hover:bg-secondary disabled:opacity-50"><CheckCheck className="h-3 w-3" />全部已读</button>
		</div>
		{error && <p role="alert" className="text-[11px] text-destructive">{error}</p>}
		{loading && !items.length ? <div className="flex justify-center gap-2 py-10 text-[11px] text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />加载消息…</div> : !items.length ? <div className="flex flex-col items-center gap-3 py-10 text-muted-foreground"><Bell className="h-7 w-7 opacity-50" /><span className="text-xs">暂无消息</span></div> : items.map(message => {
			const open = expanded.has(message.id);
			return <article key={message.id} className={`overflow-hidden rounded-xl border ${message.read ? "border-border/40 bg-secondary/15" : "border-primary/30 bg-primary/5"}`}>
				<button type="button" aria-expanded={open} onClick={() => toggle(message)} className="w-full px-4 py-3 text-left hover:bg-secondary/30 cursor-pointer">
					<span className="flex items-center gap-2">{!message.read && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />}<span className="flex-1 break-words text-xs font-semibold text-foreground">{message.title}</span>{open ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}</span>
					<span className="mt-1.5 flex flex-wrap gap-x-2 gap-y-1 text-[10px] text-muted-foreground"><span>{message.issuer === "source" ? "平台" : message.issuer === "agent" ? "渠道商" : "系统"}</span><span>{message.kind === "announcement" ? "公告" : "通知"}</span><time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleString()}</time></span>
				</button>
				{open && <div className="whitespace-pre-wrap break-words border-t border-border/30 px-4 py-3 text-[11px] leading-7 text-foreground">{message.body}</div>}
			</article>;
		})}
		{current && items.length < state.total && <button type="button" onClick={() => void load(true)} disabled={loading} className="rounded-lg border border-border/40 px-3 py-2 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50">{loading ? "加载中…" : "加载更多"}</button>}
	</section>;
}
