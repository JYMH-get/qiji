// HighlightEditable —— 原文 contentEditable 高亮编辑器：命中词渲染为绿色 <span class=qj-orig-hl>（纯字色，无底纹无描边）。
// 真实文本着色、**单层渲染** → 无叠层错位/渗边、无中文输入法隐形（区别于早期 textarea 透明叠层方案）。
// 面向 WebView2/Chromium：DOM 扁平（文本节点 + span），换行以 \n 文本 + white-space:pre-wrap 承载；
// 拦截 Enter 自插 \n、拦截 paste 注入纯文本；非受控（仅外部 value/terms 变化才重建 DOM，打字只 serialize→onChange 不丢光标）；IME 合成期不 serialize。
import { useEffect, useMemo, useRef } from "react";

/** 命中标记：terms 在 text 中出现处（去重、非空、长词优先；含单字资产名） */
function highlightFlags(text: string, terms: string[]): boolean[] {
    const flags = new Array(text.length).fill(false);
    const ts = [...new Set(terms)].filter((t) => !!t).sort((a, b) => b.length - a.length);
    for (const t of ts) {
        let i = text.indexOf(t);
        while (i >= 0) { for (let k = i; k < i + t.length; k++) flags[k] = true; i = text.indexOf(t, i + t.length); }
    }
    return flags;
}
/** 渲染：命中段包 <span class=qj-orig-hl>（绿色字体），其余文本节点（保 \n） */
function buildDom(root: HTMLElement, text: string, terms: string[]) {
    root.textContent = "";
    if (!text) return;
    const flags = highlightFlags(text, terms);
    const frag = document.createDocumentFragment();
    let i = 0;
    while (i < text.length) {
        const on = flags[i];
        let j = i + 1;
        while (j < text.length && flags[j] === on) j++;
        const seg = text.slice(i, j);
        if (on) { const s = document.createElement("span"); s.className = "qj-orig-hl"; s.textContent = seg; frag.appendChild(s); }
        else frag.appendChild(document.createTextNode(seg));
        i = j;
    }
    root.appendChild(frag);
}
/** 节点 → 文本（<br>→\n，元素递归） */
function nodeText(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const el = node as HTMLElement;
    if (el.tagName === "BR") return "\n";
    let s = "";
    el.childNodes.forEach((c) => { s += nodeText(c); });
    return s;
}
/** 序列化为纯文本；末尾浏览器填充的 <br> 丢弃 */
function serialize(root: HTMLElement): string {
    const kids = Array.from(root.childNodes);
    const last = kids[kids.length - 1];
    if (last && last.nodeType === Node.ELEMENT_NODE && (last as HTMLElement).tagName === "BR") kids.pop();
    return kids.map(nodeText).join("");
}

// 维持行尾占位 <br>：pre-wrap 下末尾换行符若无后随节点则不显示空行、光标落不上去（回车需按两次的根因）。
// 文本以换行符结尾 → 末尾补一个 bogus <br>；否则去掉游离的末尾 <br>（防幻影空行）。只动末尾 <br>，不影响光标。
function syncTrailingBr(root: HTMLElement, text: string): void {
    const last = root.lastChild;
    const hasBr = !!last && last.nodeType === Node.ELEMENT_NODE && (last as HTMLElement).tagName === "BR";
    if (text.endsWith("\n")) { if (!hasBr) root.appendChild(document.createElement("br")); }
    else if (hasBr) root.removeChild(last);
}

interface Props {
    value: string;
    onChange: (v: string) => void;
    /** 需要在原文中绿色高亮的命中词（资产名/别名等） */
    terms: string[];
    placeholder?: string;
}

export default function HighlightEditable({ value, onChange, terms, placeholder }: Props) {
    const root = useRef<HTMLDivElement>(null);
    const composing = useRef(false);
    const lastText = useRef<string | null>(null);
    const lastSig = useRef<string>("");
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;
    const sig = useMemo(() => terms.join(""), [terms]);

    const emit = () => {
        const el = root.current;
        if (!el) return;
        const text = serialize(el);
        lastText.current = text;
        onChangeRef.current(text);
        syncTrailingBr(el, text); // 行尾 "\n" 补/去占位 <br>，保回车即时换行
    };

    // 外部 value/terms 变化 → 重建 DOM（内部打字时 value===lastText 且 sig 不变 → 跳过，光标不丢）
    useEffect(() => {
        const el = root.current;
        if (!el) return;
        if (value !== lastText.current || sig !== lastSig.current) {
            lastText.current = value;
            lastSig.current = sig;
            buildDom(el, value, terms);
            syncTrailingBr(el, value);
        }
    }, [value, sig, terms]);

    const onInput = () => { if (!composing.current) emit(); };
    const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.key === "Enter") {
            e.preventDefault();
            const sel = window.getSelection();
            if (!sel || sel.rangeCount === 0) return;
            const range = sel.getRangeAt(0);
            range.deleteContents();
            const nl = document.createTextNode("\n");
            range.insertNode(nl);
            range.setStartAfter(nl);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
            if (!composing.current) emit();
        }
    };
    const onPaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
        e.preventDefault();
        const text = e.clipboardData.getData("text/plain");
        if (!text) return;
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return;
        const range = sel.getRangeAt(0);
        range.deleteContents();
        const node = document.createTextNode(text);
        range.insertNode(node);
        range.setStartAfter(node);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
        if (!composing.current) emit();
    };

    return (
        <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
            <div
                ref={root}
                className="qj-orig-editor"
                contentEditable
                suppressContentEditableWarning
                onInput={onInput}
                onKeyDown={onKeyDown}
                onPaste={onPaste}
                onCompositionStart={() => { composing.current = true; }}
                onCompositionEnd={() => { composing.current = false; emit(); }}
                style={{ height: "100%", width: "100%", boxSizing: "border-box", overflowY: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word", outline: "none", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6, color: "#e7e7ee", fontSize: 12, lineHeight: 1.6, padding: 8 }}
            />
            {!value && placeholder && (
                <div style={{ position: "absolute", top: 9, left: 9, right: 9, pointerEvents: "none", color: "rgba(255,255,255,0.35)", fontSize: 12, lineHeight: 1.6 }}>{placeholder}</div>
            )}
        </div>
    );
}
