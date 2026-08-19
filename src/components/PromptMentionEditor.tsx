// PromptMentionEditor — 提示词富文本编辑器（contentEditable）。
//
// 目标：把存储/请求里的 @Image1 / @Video1 / @Audio1（模型规范格式）在界面上渲染成
// 「@[缩略图]资产名」的胶囊，但底层值与发往上游的文本**始终是 @Image1 这套 tag**（胶囊只是显示层）。
// 还支持：输入 @ 后弹出本分镜素材选择，选中即在光标处插入对应胶囊。
//
// 实现要点（面向 WebView2 / Chromium，本工程桌面壳即此内核）：
// ·DOM 保持「扁平」：文本节点 + 胶囊 span（contentEditable=false，整体删除）。换行以 \n 文本承载，
//    配 white-space: pre-wrap 渲染；拦截 Enter 自插 \n、拦截 paste 注入纯文本，避免浏览器塞 <div>/<br>。
// ·非受控：仅当外部 value 变化（推理/提取资产/切换故事板⇄视频 tab）或素材映射变化时才重建 DOM；
//    用户打字只 serialize→onChange，不回写 DOM，从而不丢光标。
// ·输入法（中文）合成期间不 serialize，compositionend 再统一提交。
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import type { ShotMaterial } from "@/services/projectFile";
import { BADGE_BG, MENTION_TAG_RE, TAG_BADGE, mediaOf, tagToMaterial } from "@/lib/shotMaterials";
import { PRESET_TAG_RE, presetBody, type PresetOption } from "@/lib/presetSchemes";
import { insertPresetCapsule } from "@/lib/promptCompose";
import { upstreamTag, UPSTREAM_TAG_RE } from "@/lib/upstreamText";
import { computeChangedFlags, rangeChanged } from "@/lib/wordDiff";
import { mediaFilesFromClipboard } from "@/lib/clipboardMedia";

export interface PromptMentionHandle {
    /** 在当前光标处插入素材引用胶囊（tag=@Image1…）。replaceTrigger=true 时先吃掉光标前刚输入的触发符（'@' 或 '#'）。
     *  mat=素材数据时直接据此建胶囊（用于 # 导入：素材刚加进 store、materials prop 尚未刷新时也能立即渲染）。 */
    insertMaterial: (tag: string, replaceTrigger?: boolean, mat?: ShotMaterial) => void;
    /** 在当前光标处插入预设胶囊（底层文本=【预设:id】，提交时展开成完整预设正文）。 */
    insertPreset: (id: string, name: string) => void;
    focus: () => void;
}

interface Props {
    value: string;
    materials: ShotMaterial[];
    /** 出图预设方案（供把 【预设:id】 渲染成带名字的 pill；缺省/空=不识别预设胶囊，按纯文本显示） */
    presets?: PresetOption[];
    placeholder?: string;
    onChange: (text: string) => void;
    /** 用户在编辑器里输入 '@'（位于光标前）→ 回传光标屏幕坐标用于弹出选择层；非 '@' 触发回传 null */
    onMentionProbe?: (pos: { x: number; y: number } | null) => void;
    /** 用户在编辑器里输入 '#'（位于光标前）→ 回传光标屏幕坐标用于弹出「导入项目资产」选择层；非 '#' 触发回传 null */
    onImportProbe?: (pos: { x: number; y: number } | null) => void;
    /** 在输入框粘贴了图片/视频/音频文件 → 上层把它们加入素材区（不插入文本） */
    onPasteMedia?: (files: File[]) => void;
    /** 高亮基线：推理产出的原始提示词。用户编辑后与此做词级 diff，把「确认更改」的部分高亮（黄色）供检查；
     *  删了又填回同样的词不高亮（LCS 对齐，非按字符位置对比）。undefined=不高亮。 */
    diffBase?: string;
    style?: React.CSSProperties;
    className?: string;
}

/** 构建一枚素材胶囊 span（@[缩略图]资产名）；data-tag 保存模型规范 tag，序列化时还原成它 */
function makeChip(tag: string, mat: ShotMaterial): HTMLSpanElement {
    const md = mediaOf(mat);
    const span = document.createElement("span");
    span.className = "qj-mention-chip";
    span.contentEditable = "false";
    span.dataset.tag = tag;
    span.title = `${tag}·${mat.name || ""}`;
    // "@" 前缀
    const at = document.createElement("span");
    at.className = "qj-mention-at";
    at.textContent = "@";
    span.appendChild(at);
    // 缩略图（图像→真图；视频/音频→图标占位）
    const thumb = document.createElement("span");
    thumb.className = "qj-mention-thumb";
    thumb.style.background = BADGE_BG[md];
    if (mat.uri && md === "image") {
        const img = document.createElement("img");
        img.src = mat.uri;
        img.alt = "";
        thumb.appendChild(img);
    } else {
        thumb.textContent = md === "video" ? "▶" : md === "audio" ? "🎵" : TAG_BADGE[md];
    }
    span.appendChild(thumb);
    // 资产名
    const name = document.createElement("span");
    name.className = "qj-mention-name";
    name.textContent = mat.name || tag;
    span.appendChild(name);
    return span;
}

/** 构建一枚预设方案胶囊 span（【预设:id】→ ▦ 预设名）；data-tag 保存标记文本，序列化时还原成它 */
function makePresetChip(tag: string, name: string): HTMLSpanElement {
    const span = document.createElement("span");
    span.className = "qj-mention-chip qj-preset-chip";
    span.contentEditable = "false";
    span.draggable = true; // 可长按拖动改变位置
    span.dataset.tag = tag;
    span.title = `预设方案·${name}（可拖动改位置 · 双击展开为正文）`;
    // 与素材胶囊区分：琥珀色底 + 网格图标（无缩略图）
    span.style.background = "rgba(245,158,11,0.16)";
    span.style.border = "1px solid rgba(245,158,11,0.55)";
    span.style.color = "#fcd34d";
    const ic = document.createElement("span");
    ic.className = "qj-mention-at";
    ic.textContent = "▦";
    ic.style.color = "#fcd34d";
    span.appendChild(ic);
    const nm = document.createElement("span");
    nm.className = "qj-mention-name";
    nm.textContent = name;
    span.appendChild(nm);
    return span;
}

/** 构建「上游文本N」胶囊 span（【上游文本N】→ ▤ 上游文本N）；data-tag 保存标记，序列化时还原成它。
 *  青色区分于素材（蓝）/预设（琥珀）；提交时由 pluginRegistry 按编号还原成对应上游节点的文本。 */
function makeUpstreamChip(n: number): HTMLSpanElement {
    const span = document.createElement("span");
    span.className = "qj-mention-chip qj-upstream-chip";
    span.contentEditable = "false";
    span.draggable = true; // 可长按拖动改变位置
    span.dataset.tag = upstreamTag(n);
    span.title = `上游文本${n}：提交时自动替换为第 ${n} 个上游节点输出的文本（可拖动改位置）`;
    span.style.background = "rgba(45,212,191,0.16)";
    span.style.border = "1px solid rgba(45,212,191,0.55)";
    span.style.color = "#5eead4";
    const ic = document.createElement("span");
    ic.className = "qj-mention-at";
    ic.textContent = "▤";
    ic.style.color = "#5eead4";
    span.appendChild(ic);
    const nm = document.createElement("span");
    nm.className = "qj-mention-name";
    nm.textContent = `上游文本${n}`;
    span.appendChild(nm);
    return span;
}

/** 把 [start,end) 的文本作为节点追加，flags 标记的更改区段包成 <mark class=qj-mention-diff>（黄色高亮） */
function appendText(frag: DocumentFragment, text: string, start: number, end: number, flags?: boolean[]) {
    if (end <= start) return;
    if (!flags) { frag.appendChild(document.createTextNode(text.slice(start, end))); return; }
    let i = start;
    while (i < end) {
        const on = flags[i];
        let j = i + 1;
        while (j < end && !!flags[j] === !!on) j++;
        const piece = text.slice(i, j);
        if (on) { const mk = document.createElement("mark"); mk.className = "qj-mention-diff"; mk.textContent = piece; frag.appendChild(mk); }
        else frag.appendChild(document.createTextNode(piece));
        i = j;
    }
}

/** 把 plain text（含 @tag / 【预设:id】）渲染进 root：@tag→素材胶囊、【预设:id】→预设胶囊，其余→文本节点（保 \n）；flags 高亮更改 */
function buildDom(root: HTMLElement, text: string, tagToMat: Map<string, ShotMaterial>, presetById?: Map<string, string>, flags?: boolean[]) {
    root.textContent = "";
    if (!text) return;
    const frag = document.createDocumentFragment();
    // 一次扫描同时匹配 素材 @tag / 预设胶囊【预设:id】 / 上游文本胶囊【上游文本N】
    // 组序：MENTION 无组 → PRESET 组1=id → UPSTREAM 组2=编号（m[1] 有值=预设，m[2] 有值=上游文本）
    const re = new RegExp(`${MENTION_TAG_RE.source}|${PRESET_TAG_RE.source}|${UPSTREAM_TAG_RE.source}`, "g");
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        if (m.index > last) appendText(frag, text, last, m.index, flags);
        const tag = m[0];
        const changed = rangeChanged(flags, m.index, m.index + tag.length);
        let node: Node;
        if (m[2] !== undefined) {
            node = makeUpstreamChip(Number(m[2]));
        } else if (m[1] !== undefined) {
            // 预设胶囊：命中 catalog 用名字，否则用 id 兜底显示（仍是可用的胶囊）
            node = makePresetChip(tag, presetById?.get(m[1]) || m[1]);
        } else {
            const mat = tagToMat.get(tag);
            node = mat ? makeChip(tag, mat) : document.createTextNode(tag);
        }
        if (changed && node.nodeType === Node.ELEMENT_NODE) (node as HTMLElement).classList.add("qj-mention-diff-chip");
        else if (changed) { const mk = document.createElement("mark"); mk.className = "qj-mention-diff"; mk.appendChild(node); frag.appendChild(mk); last = m.index + tag.length; continue; }
        frag.appendChild(node);
        last = m.index + tag.length;
    }
    if (last < text.length) appendText(frag, text, last, text.length, flags);
    root.appendChild(frag);
}

/** 单个节点 → plain text（胶囊→data-tag、<br>→\n、文本→原样、包裹元素→递归） */
function nodeText(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const el = node as HTMLElement;
    if (el.dataset.tag) return el.dataset.tag;
    if (el.tagName === "BR") return "\n";
    let s = ""; // 防御：粘贴/浏览器可能塞的包裹元素
    el.childNodes.forEach((c) => { s += nodeText(c); });
    return s;
}
/** 把编辑器 DOM 序列化回 plain text；末尾若是浏览器填充的 filler <br> 则丢弃（避免清空后残留 "\n"） */
function serialize(root: HTMLElement): string {
    const kids = Array.from(root.childNodes);
    const last = kids[kids.length - 1];
    if (last && last.nodeType === Node.ELEMENT_NODE && (last as HTMLElement).tagName === "BR") kids.pop();
    return kids.map(nodeText).join("");
}

// 维持「行尾占位 <br>」不变式：pre-wrap 下末尾的换行符若无后随节点则不显示空行（Chromium/WebView2），
// 需在末尾补一个 bogus <br> 才能显示、且光标能落到那空行（这也是回车需按两次才换行的根因）。
// 规则：serialize 后文本以换行符结尾 → 末尾应有一个 <br>；否则去掉游离的末尾 <br>（防幻影空行）。只动末尾 <br>，不影响光标。
function syncTrailingBr(root: HTMLElement, text: string): void {
    const last = root.lastChild;
    const hasBr = !!last && last.nodeType === Node.ELEMENT_NODE && (last as HTMLElement).tagName === "BR";
    if (text.endsWith("\n")) { if (!hasBr) root.appendChild(document.createElement("br")); }
    else if (hasBr) root.removeChild(last);
}

/** 当前折叠光标的屏幕坐标（用于定位 @ 选择层）；取不到时回退到编辑器左下角，绝不改 DOM */
function caretRect(root: HTMLElement | null): { x: number; y: number } | null {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
        const r = sel.getRangeAt(0).cloneRange();
        r.collapse(true);
        const rect = r.getBoundingClientRect();
        if (rect && (rect.left || rect.top || rect.bottom)) return { x: rect.left, y: rect.bottom };
    }
    if (root) { const er = root.getBoundingClientRect(); return { x: er.left + 12, y: er.top + 24 }; }
    return null;
}

const PromptMentionEditor = forwardRef<PromptMentionHandle, Props>(function PromptMentionEditor(
    { value, materials, presets, placeholder, onChange, onMentionProbe, onImportProbe, onPasteMedia, diffBase, style, className },
    ref,
) {
    const root = useRef<HTMLDivElement>(null);
    const composing = useRef(false);
    const lastText = useRef<string | null>(null); // 上次「我们渲染/序列化」的文本（区分内部打字 vs 外部更新）
    const lastSig = useRef<string>("");
    const lastPresetSig = useRef<string>("");
    const lastDiff = useRef<string | undefined>(undefined); // 上次用于高亮的基线
    const savedRange = useRef<Range | null>(null); // 进入 @ 弹层前的光标快照（点击弹层会偷走焦点、折叠选区）
    const pendingCaretEnd = useRef(false); // # 导入后素材变化会触发重建 → 标记「重建后把光标移到末尾」
    const draggingChip = useRef<HTMLElement | null>(null); // 正在拖动的 预设/上游 胶囊（拖放改位置）

    const tagToMat = useMemo(() => tagToMaterial(materials), [materials]);
    const matsSig = useMemo(() => materials.map((m) => `${m.id}:${m.name}:${m.uri}:${m.media || "image"}`).join("|"), [materials]);
    const presetById = useMemo(() => new Map((presets ?? []).map((p) => [p.id, p.name])), [presets]);
    const presetSig = useMemo(() => (presets ?? []).map((p) => `${p.id}:${p.name}`).join("|"), [presets]);
    // 给稳定的命令式句柄用（避免句柄随每次打字重建、且不闭包到旧的 onChange/tab）：始终指向最新值
    const tagToMatRef = useRef(tagToMat);
    tagToMatRef.current = tagToMat;
    const presetByIdRef = useRef(presetById);
    presetByIdRef.current = presetById;
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;

    // 序列化 → 上抛（不回写 DOM，保光标）。经 ref 取 onChange，避免命令式句柄里调到旧 tab 的回调。
    const emit = () => {
        const el = root.current;
        if (!el) return;
        const text = serialize(el);
        lastText.current = text;
        onChangeRef.current(text);
        syncTrailingBr(el, text); // 行尾 "\n" 补/去占位 <br>，保回车即时换行
    };

    // 快照当前折叠光标（仅当其落在编辑器内）。供 insertMaterial 在弹层偷走焦点后恢复原位，
    // 否则点击弹层 contentEditable 失焦→选区折叠到开头→胶囊会插到最前面。
    const saveCaret = () => {
        const el = root.current;
        const sel = window.getSelection();
        if (!el || !sel || sel.rangeCount === 0) return;
        const r = sel.getRangeAt(0);
        if (el.contains(r.startContainer)) savedRange.current = r.cloneRange();
    };

    // 外部值/素材映射/高亮基线变化 → 重建 DOM（内部打字时 value===lastText 且 sig/diff 不变 → 跳过，光标不丢）
    useEffect(() => {
        const el = root.current;
        if (!el) return;
        if (value !== lastText.current || matsSig !== lastSig.current || presetSig !== lastPresetSig.current || diffBase !== lastDiff.current) {
            lastText.current = value;
            lastSig.current = matsSig;
            lastPresetSig.current = presetSig;
            lastDiff.current = diffBase;
            // 仅当基线存在且与当前不同才算 diff（推理刚出 base===value → 无高亮）
            const flags = diffBase && diffBase !== value ? computeChangedFlags(value, diffBase) : undefined;
            buildDom(el, value, tagToMat, presetById, flags);
            syncTrailingBr(el, value);
            // # 导入触发的重建：素材变化重建会丢光标 → 把光标移到末尾并聚焦（否则用户看不到落点）
            if (pendingCaretEnd.current) {
                pendingCaretEnd.current = false;
                const sel = window.getSelection();
                if (sel) {
                    const r = document.createRange();
                    r.selectNodeContents(el);
                    r.collapse(false);
                    sel.removeAllRanges();
                    sel.addRange(r);
                    savedRange.current = r.cloneRange();
                }
                el.focus();
            }
        }
    }, [value, matsSig, presetSig, tagToMat, presetById, diffBase]);

    // 在当前光标处插入一枚胶囊/文本节点（素材胶囊、预设胶囊共用同一套光标/缓冲空格逻辑）。
    const insertChipAtCaret = (chip: Node, replaceTrigger: boolean, markPending: boolean) => {
        const el = root.current;
        if (!el) return;
        el.focus();
        const sel = window.getSelection();
        if (!sel) return;
        // 优先恢复「进入弹层前保存的光标」（点击弹层会让 contentEditable 失焦、选区折叠到开头，
        // 不恢复就会把胶囊插到最前面、且吃触发符逻辑因 offset=0 失效残留重复符号）。
        const saved = savedRange.current;
        if (saved && el.contains(saved.startContainer)) {
            sel.removeAllRanges();
            sel.addRange(saved);
        } else if (sel.rangeCount === 0 || !el.contains(sel.anchorNode)) {
            // 没有可用光标 → 落到末尾
            const r = document.createRange();
            r.selectNodeContents(el);
            r.collapse(false);
            sel.removeAllRanges();
            sel.addRange(r);
        }
        const range = sel.getRangeAt(0);
        range.deleteContents();
        // 吃掉光标前刚输入的触发符 '@'/'#'（仅同文本节点、紧邻一字符）。删除前快照 off——
        // deleteData 可能自动回退本 range 的 startOffset，二次读会再偏一格，故一律用快照 off 定位。
        if (replaceTrigger && range.startContainer.nodeType === Node.TEXT_NODE && range.startOffset > 0) {
            const tn = range.startContainer as Text;
            const off = range.startOffset;
            const prev = (tn.textContent ?? "")[off - 1];
            if (prev === "@" || prev === "#") {
                tn.deleteData(off - 1, 1);
                range.setStart(tn, off - 1);
                range.collapse(true);
            }
        }
        range.insertNode(chip);
        // 光标紧贴胶囊之后——原地引用，不再凭空补空格让后文整体"前进一格"
        range.setStartAfter(chip);
        range.collapse(true);
        // 仅在确有必要时补一个分隔空格，且光标仍停在胶囊与空格之间（空格作缓冲、不越过）：
        // ·胶囊位于末尾（contentEditable=false 元素后无文本，光标无处可落）→ 给光标一个家；
        // ·紧跟数字 → 防 @Image1 与后随数字粘连成 @Image12 串号。
        const after = chip.nextSibling;
        const nextChar = after && after.nodeType === Node.TEXT_NODE ? (after.textContent ?? "")[0] ?? "" : "";
        if (after === null || /\d/.test(nextChar)) {
            const tail = document.createTextNode(" ");
            if (after) chip.parentNode?.insertBefore(tail, after);
            else chip.parentNode?.appendChild(tail);
            range.setStartAfter(chip); // 光标仍停在胶囊后、缓冲空格之前
            range.collapse(true);
        }
        sel.removeAllRanges();
        sel.addRange(range);
        savedRange.current = range.cloneRange(); // 同步快照，避免连续插入时回到旧位
        // # 导入（改了素材列表）会触发重建丢光标，标记「重建后光标移到末尾」
        if (markPending) pendingCaretEnd.current = true;
        emit();
    };
    const insertChipRef = useRef(insertChipAtCaret);
    insertChipRef.current = insertChipAtCaret;

    useImperativeHandle(ref, () => ({
        focus: () => root.current?.focus(),
        insertMaterial: (tag: string, replaceTrigger = false, matArg?: ShotMaterial) => {
            // 优先用传入的素材数据建胶囊（# 导入：materials prop 尚未刷新时也能立即渲染），否则查当前映射
            const mat = matArg ?? tagToMatRef.current.get(tag);
            const chip: Node = mat ? makeChip(tag, mat) : document.createTextNode(tag);
            insertChipRef.current(chip, replaceTrigger, !!matArg);
        },
        insertPreset: (id: string, _name: string) => {
            // 预设按位置落位（前缀→正文最前 / 后缀→正文最后）+ 互斥去重，走字符串组合 → 回传 value 触发重建。
            const el = root.current;
            if (!el) return;
            const cur = serialize(el);
            const next = insertPresetCapsule(cur, id);
            if (next !== cur) onChangeRef.current(next); // value 变 → 外部回传 → 效果重建 DOM 渲染 pill
        },
    }), []); // eslint-disable-line react-hooks/exhaustive-deps

    const onInput = () => {
        if (composing.current) return;
        emit();
        saveCaret(); // 打字后快照光标——弹层弹出前的位置就靠这一帧
        // 探测触发符：光标前一字符为 '@' → 开素材引用弹层；'#' → 开导入资产弹层；否则两个都关。
        const sel = window.getSelection();
        let prev = "";
        if (sel && sel.rangeCount > 0 && sel.isCollapsed) {
            const r = sel.getRangeAt(0);
            if (r.startContainer.nodeType === Node.TEXT_NODE && r.startOffset > 0) {
                prev = (r.startContainer.textContent ?? "")[r.startOffset - 1] ?? "";
            }
        }
        const pos = prev === "@" || prev === "#" ? caretRect(root.current) : null;
        onMentionProbe?.(prev === "@" ? pos : null);
        onImportProbe?.(prev === "#" ? pos : null);
    };

    const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        // Enter 自插 \n（保 DOM 扁平，不让浏览器造 <div>/<br>）；Shift+Enter 同样换行
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
        // 粘贴图片/视频/音频文件（如截图）→ 交上层加入素材区，不当文本插入
        if (onPasteMedia) {
            const media = mediaFilesFromClipboard(e);
            if (media.length) { e.preventDefault(); onPasteMedia(media); return; }
        }
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

    // 双击预设胶囊 → 就地展开为可编辑的普通正文（把 【预设:id】 替换成完整预设词文本）
    const onDblClick = (e: React.MouseEvent<HTMLDivElement>) => {
        const chip = (e.target as HTMLElement | null)?.closest?.(".qj-preset-chip") as HTMLElement | null;
        if (!chip || !root.current?.contains(chip)) return;
        const mm = /【预设:([A-Za-z0-9._-]+)】/.exec(chip.dataset.tag || "");
        if (!mm) return;
        const body = presetBody(mm[1]);
        if (!body) return;
        e.preventDefault();
        const tn = document.createTextNode(body);
        chip.replaceWith(tn);
        const sel = window.getSelection();
        if (sel) { const r = document.createRange(); r.setStartAfter(tn); r.collapse(true); sel.removeAllRanges(); sel.addRange(r); savedRange.current = r.cloneRange(); }
        emit();
    };

    const isEmpty = !value;
    return (
        <div
            className={`qj-mention-editor-wrap${className ? ` ${className}` : ""}`}
            style={{ position: "relative", display: "flex", flexDirection: "column", boxSizing: "border-box", overflow: "hidden", ...style }}
        >
            <div
                ref={root}
                className="qj-mention-editor"
                contentEditable
                suppressContentEditableWarning
                onInput={onInput}
                onKeyDown={onKeyDown}
                onKeyUp={saveCaret}
                onMouseUp={saveCaret}
                onDoubleClick={onDblClick}
                onDragStart={(e) => {
                    // 只接管 预设/上游 胶囊的拖动；其它（文本选区）走浏览器默认
                    const chip = (e.target as HTMLElement | null)?.closest?.(".qj-preset-chip, .qj-upstream-chip") as HTMLElement | null;
                    if (chip && root.current?.contains(chip)) {
                        draggingChip.current = chip;
                        try { e.dataTransfer?.setData("text/plain", chip.dataset.tag || ""); if (e.dataTransfer) e.dataTransfer.effectAllowed = "move"; } catch { /* noop */ }
                    } else draggingChip.current = null;
                }}
                onDragOver={(e) => { if (draggingChip.current) e.preventDefault(); }}
                onDrop={(e) => {
                    const chip = draggingChip.current;
                    draggingChip.current = null;
                    const el = root.current;
                    if (!chip || !el) return;
                    e.preventDefault();
                    const dc = document as unknown as { caretRangeFromPoint?: (x: number, y: number) => Range | null; caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null };
                    let range: Range | null = null;
                    if (dc.caretRangeFromPoint) range = dc.caretRangeFromPoint(e.clientX, e.clientY);
                    else if (dc.caretPositionFromPoint) { const p = dc.caretPositionFromPoint(e.clientX, e.clientY); if (p) { range = document.createRange(); range.setStart(p.offsetNode, p.offset); } }
                    // 落点必须在编辑器内、且不在被拖胶囊自身内
                    if (!range || !el.contains(range.startContainer) || chip.contains(range.startContainer)) return;
                    chip.remove();
                    range.collapse(true);
                    range.insertNode(chip);
                    range.setStartAfter(chip);
                    range.collapse(true);
                    const sel = window.getSelection();
                    if (sel) { sel.removeAllRanges(); sel.addRange(range); savedRange.current = range.cloneRange(); }
                    emit();
                }}
                onPaste={onPaste}
                onBlur={() => {
                    // 失焦后用最新文本重算「更改高亮」（打字期间不重建以保光标，故在此刷新）
                    const el = root.current;
                    if (!el || !diffBase) return;
                    const text = serialize(el);
                    lastText.current = text;
                    const flags = diffBase !== text ? computeChangedFlags(text, diffBase) : undefined;
                    buildDom(el, text, tagToMat, presetByIdRef.current, flags);
                    syncTrailingBr(el, text);
                }}
                onCompositionStart={() => { composing.current = true; }}
                onCompositionEnd={() => { composing.current = false; emit(); }}
                style={{ flex: 1, minHeight: 0, width: "100%", boxSizing: "border-box", overflowY: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word", outline: "none" }}
            />
            {isEmpty && placeholder && (
                <div className="qj-mention-placeholder" style={{ position: "absolute", top: 8, left: 10, right: 10, pointerEvents: "none", color: "var(--muted-foreground)", fontSize: 12, lineHeight: 1.6 }}>
                    {placeholder}
                </div>
            )}
        </div>
    );
});

export default PromptMentionEditor;
