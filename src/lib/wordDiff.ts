// ── 词级 diff（用于高亮「用户对推理结果的更改」，PromptMentionEditor 用）──
// 分词：@tag 原子 / 英文词 / 数字串 / 单个 CJK 字 / 空白串 / 其它单字符。CJK 按字、拉丁按词，
// 与用户「不是按字符位置对比」诉求一致：删了又填回同样的词不高亮（LCS 对齐）。
// 例：「此处的左边有更改」→「此处的最右边没有更改」仅高亮新增的「最右」「没」。

export const DIFF_TOKEN_RE = /@(?:Image|Video|Audio)\d+|[A-Za-z]+|[0-9]+|\s+|[㐀-鿿豈-﫿]|[^\s]/g;

export function tokenizeWithPos(s: string): { t: string; start: number; end: number }[] {
    const out: { t: string; start: number; end: number }[] = [];
    const re = new RegExp(DIFF_TOKEN_RE.source, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(s)) !== null) {
        out.push({ t: m[0], start: m.index, end: m.index + m[0].length });
        if (re.lastIndex === m.index) re.lastIndex++; // 防零宽死循环
    }
    return out;
}

/**
 * 计算 text 中相对 base「有更改/新增」的字符标记（boolean[]，长度=text.length）。
 * 经 token 级 LCS：current 中不属于最长公共子序列的 token = 更改（纯空白 token 不高亮，避免不可见标记）。
 * 体量过大（≈2000×2000 token）时返回 undefined（不高亮）以避免卡顿。
 */
export function computeChangedFlags(text: string, base: string): boolean[] | undefined {
    if (!text) return undefined;
    const cur = tokenizeWithPos(text);
    const a = cur.map((x) => x.t);
    const b = tokenizeWithPos(base).map((x) => x.t);
    const n = a.length, mlen = b.length;
    if (n === 0) return undefined;
    if (mlen === 0) return new Array(text.length).fill(true); // 无基线全文 = 全新
    if (n * mlen > 4_000_000) return undefined;                // 体量保护
    // LCS 长度表（自底向上）
    const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(mlen + 1));
    for (let i = n - 1; i >= 0; i--) {
        const di = dp[i], di1 = dp[i + 1];
        for (let j = mlen - 1; j >= 0; j--) {
            di[j] = a[i] === b[j] ? di1[j + 1] + 1 : (di1[j] >= di[j + 1] ? di1[j] : di[j + 1]);
        }
    }
    // 回溯：标记 current 中落在 LCS 上的 token
    const matched = new Array(n).fill(false);
    let i = 0, j = 0;
    while (i < n && j < mlen) {
        if (a[i] === b[j]) { matched[i] = true; i++; j++; }
        else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
        else j++;
    }
    const flags = new Array(text.length).fill(false);
    for (let k = 0; k < n; k++) {
        if (matched[k] || /^\s+$/.test(a[k])) continue; // 未匹配=更改；纯空白不高亮
        for (let p = cur[k].start; p < cur[k].end; p++) flags[p] = true;
    }
    return flags;
}

/** [start,end) 区间内是否存在被标记为更改的字符 */
export function rangeChanged(flags: boolean[] | undefined, start: number, end: number): boolean {
    if (!flags) return false;
    for (let p = start; p < end; p++) if (flags[p]) return true;
    return false;
}
