/**
 * fuzzyMatch — 轻量模糊搜索 + 中文拼音首字母匹配
 *
 * 支持两种匹配模式（自动合并）：
 *   1. 子串包含：query 是否是 target 的子串
 *   2. 拼音首字母：query 是否是 target 的拼音首字母缩写
 *
 * 返回 { match: boolean; score: number }，score 越高越优。
 */
const PINYIN_INITIALS: Record<string, string> = {
  文: "w", 本: "b", 生: "s", 成: "c", 编: "b", 辑: "j",
  提: "t", 示: "s", 词: "c", 反: "f", 推: "t", 写: "x",
  脚: "j", 剧: "j", 拆: "c", 分: "f", 镜: "j", 角: "j",
  色: "s", 驱: "q", 动: "d",
  图: "t", 片: "p", 画: "h", 像: "x", 图像: "tx",
  视: "s", 频: "p", 视频: "sp",
  音: "y", 音频: "yp", 配: "p", 音效: "yx", 背景: "bj",
  文档: "wd", 素材: "sc",
  管: "g", 理: "l", 器: "q",
  上传: "sc2", 图片: "tp",
  选用: "xy", 库内: "kn", 从: "c",
  生成: "sc3", 节点: "jd", 生成节点: "sc3jd",
};

function getPinyinInitials(str: string): string {
  const chars = str.split("");
  return chars.map((ch) => {
    if (PINYIN_INITIALS[ch]) return PINYIN_INITIALS[ch];
    // ASCII 字符直接保留
    if (/[a-zA-Z0-9]/.test(ch)) return ch.toLowerCase();
    // 未知中文字符用 '?' 标记
    return /[^\x00-\x7F]/.test(ch) ? "?" : ch.toLowerCase();
  }).join("");
}

export interface FuzzyMatchResult {
  match: boolean;
  score: number;
  /** 标记匹配到的字符位置，用于高亮（可选） */
  matchedIndices?: number[];
}

/**
 * 模糊匹配：query 匹配 target 时返回 true + 得分。
 *
 * 得分规则（越高越好）：
 *   - 完全相等：1000
 *   - 前缀匹配：900 - index*10
 *   - 子串包含：800 - index*10
 *   - 拼音首字母匹配：700 - index*10
 *   - 不匹配：0
 */
export function fuzzyMatch(query: string, target: string): FuzzyMatchResult {
  if (!query.trim()) return { match: true, score: 0 };
  const q = query.toLowerCase().trim();
  const t = target.toLowerCase();

  // 1. 完全相等
  if (q === t) return { match: true, score: 1000 };

  // 2. 前缀匹配
  if (t.startsWith(q)) {
    return { match: true, score: 900 - q.length };
  }

  // 3. 子串包含
  const idx = t.indexOf(q);
  if (idx >= 0) {
    return { match: true, score: 800 - idx * 10 };
  }

  // 4. 拼音首字母匹配
  const initials = getPinyinInitials(target);
  const initialsIdx = initials.indexOf(q);
  if (initialsIdx >= 0) {
    return { match: true, score: 700 - initialsIdx * 10 };
  }

  // 5. 不匹配
  return { match: false, score: 0 };
}

/**
 * 对选项列表做模糊排序，返回按 score 降序排列的结果。
 */
export function fuzzyFilter<T>(
  items: T[],
  query: string,
  extractor: (item: T) => string,
): { item: T; score: number }[] {
  return fuzzyFilterMulti(items, query, [extractor]);
}

/**
 * 多字段模糊排序，取各字段最高分，按 score 降序排列。
 */
export function fuzzyFilterMulti<T>(
  items: T[],
  query: string,
  extractors: ((item: T) => string | undefined)[],
): { item: T; score: number }[] {
  const results = items
    .map((item) => {
      let bestScore = 0;
      for (const ext of extractors) {
        const text = ext(item);
        if (!text) continue;
        const { match, score } = fuzzyMatch(query, text);
        if (match && score > bestScore) bestScore = score;
      }
      return { item, score: bestScore, match: bestScore > 0 };
    })
    .filter((r) => r.match);
  results.sort((a, b) => b.score - a.score);
  return results;
}