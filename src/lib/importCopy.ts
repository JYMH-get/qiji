/**
 * importCopy —— 「导入项目 = 新建项目并复制素材」的纯逻辑层。
 *
 * 语义（第173轮用户定，勿回退成「读进内存不落盘」）：导入 .Qiji 绝不影响源文件/源项目——
 * 导入即在本机用户数据目录新建一个项目文件夹，把项目 JSON 里引用到的**本地素材文件**
 * 复制进新项目 assets/，并把 JSON 里的本地引用改写为新路径；源项目全程只读。
 *
 * 本文件只做纯字符串/结构处理（可单测）：识别本地引用、深度收集、按映射改写。
 * 真正的文件复制/落盘在 projectStore 的导入实现（Tauri 层）。
 */
import { isWebviewLocalUri } from "@/lib/publicUrl";

export interface LocalRef {
	/** JSON 里的原始字符串（改写时按它精确整串替换） */
	raw: string;
	/** 解出的本地文件绝对路径 */
	path: string;
	/** raw 的形态：显示 uri（asset:// / http://*.localhost）还是裸路径——决定改写回哪种形态 */
	kind: "uri" | "path";
}

/** 取文件名（同时容忍 / 与 \ 分隔符；无名返回空串） */
export function fileNameOf(path: string): string {
	return path.split(/[/\\]/).pop() || "";
}

/**
 * 从单个字符串解出本地文件引用。只认三种形态：
 *  - `http(s)://*.localhost/<编码路径>`（convertFileSrc 在 Win/WebView2 下的产物）
 *  - `asset://<host>/<编码路径>`（convertFileSrc 在其它平台的产物）
 *  - 裸 Windows 绝对路径（盘符 / UNC）
 * 其余（真公网 http(s)、data:、blob:、相对路径、路由串如 /frame1693 等）一律返回 null——
 * 尤其不能把公网 OSS url 认成本地引用（那是要原样保留的云端兜底）。
 */
export function localRefOf(s: string): LocalRef | null {
	if (!s || s.length > 2048) return null; // 剧本/提示词等长文本直接排除
	if (/^(data:|blob:)/i.test(s)) return null;
	if (isWebviewLocalUri(s) || /^asset:\/\//i.test(s)) {
		try {
			const u = new URL(s);
			let p = u.pathname.replace(/^\/+/, "");
			try { p = decodeURIComponent(p); } catch { /* 含裸 % 的路径原样用 */ }
			if (!p) return null;
			return { raw: s, path: p, kind: "uri" };
		} catch {
			return null;
		}
	}
	// 裸 Windows 绝对路径（盘符 / UNC）。posix 前缀 "/" 不认——项目里大量路由串（/frame1693）会误伤；
	// 跨系统导入的 posix 路径在本机也不存在，留给公网 url 自愈。
	if (/^[A-Za-z]:[\\/]/.test(s) || /^\\\\/.test(s)) return { raw: s, path: s, kind: "path" };
	return null;
}

/** 深度收集 JSON 值里的全部本地引用（raw → LocalRef，按 raw 去重；只走值不走键）。 */
export function collectLocalRefs(data: unknown): Map<string, LocalRef> {
	const out = new Map<string, LocalRef>();
	const walk = (v: unknown): void => {
		if (typeof v === "string") {
			if (!out.has(v)) {
				const r = localRefOf(v);
				if (r) out.set(v, r);
			}
			return;
		}
		if (Array.isArray(v)) {
			for (const x of v) walk(x);
			return;
		}
		if (v && typeof v === "object") {
			for (const k of Object.keys(v as object)) walk((v as Record<string, unknown>)[k]);
		}
	};
	walk(data);
	return out;
}

/** 按 raw→new 映射深度改写字符串值（就地修改传入对象），返回改写处数（同串多处逐处计）。 */
export function applyRefRewrites(data: unknown, rewrites: Map<string, string>): number {
	if (rewrites.size === 0) return 0;
	let n = 0;
	const walk = (v: unknown): unknown => {
		if (typeof v === "string") {
			const m = rewrites.get(v);
			if (m !== undefined) { n++; return m; }
			return v;
		}
		if (Array.isArray(v)) {
			for (let i = 0; i < v.length; i++) v[i] = walk(v[i]);
			return v;
		}
		if (v && typeof v === "object") {
			const o = v as Record<string, unknown>;
			for (const k of Object.keys(o)) o[k] = walk(o[k]);
			return v;
		}
		return v;
	};
	walk(data);
	return n;
}
