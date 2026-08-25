/**
 * splitChoices —— 剧集拆分「快速拆分」内置方式清单（不调用大模型的确定性切分）。
 *
 * id 为历史值（曾内联在 Frame1693），第243轮起随 mediaSettings.episodeTplId 持久化进项目文件——勿改值。
 * 消费方：Frame1693（剧本编辑器下拉）与 Frame164（新建项目页「提示词方案」）共用同一份。
 * 实际切分实现见 lib/episodeSplit.ts（本文件只承载 id 与显示文案）。
 */
export const QUICK_SPLIT_ID = "__quick_split__";          // 按「第N集/章/回」标记
export const QUICK_BLANKLINE_ID = "__quick_blankline__";  // 按连续两次换行（空行）
export const QUICK_N1_ID = "__quick_n1__";                // n-1：按空行切大集，编号 1-1, 2-1, 3-1
export const QUICK_NN_ID = "__quick_nn__";                // n-n：大集(空行)内再按单换行切小集（更细，默认）

export const QUICK_SPLIT_CHOICES: { id: string; label: string }[] = [
    { id: QUICK_SPLIT_ID, label: "快速·按「第N集」标记" },
    { id: QUICK_BLANKLINE_ID, label: "快速·按连续两次换行（空行）" },
    { id: QUICK_N1_ID, label: "快速·n-1（逢主编号拆分 1-1,2-1,3-1；兼容 场1-1）" },
    { id: QUICK_NN_ID, label: "快速·n-n（逢编号拆分 1-1,1-2,2-1，更细；兼容 场1-1）" },
];

export const QUICK_SPLIT_IDS = new Set(QUICK_SPLIT_CHOICES.map((c) => c.id));
