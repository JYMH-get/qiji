/**
 * 画布快捷键注册表（单一事实来源）。
 *
 * - 每个**可自定义**动作一条 KeymapAction：id / 中文名 / 分类 / 默认组合键。
 * - 组合键规范化串：修饰键按 ctrl→alt→shift 排序 + 主键小写，用 "+" 连接，
 *   如 "ctrl+shift+c"、"c"、"delete"、"ctrl+enter"。meta(⌘) 归一为 ctrl。
 * - 用户覆盖存 settingsStore.canvasKeymap（actionId→combo，settings.json 持久化）；
 *   设置面板「快捷键」tab 点击键位胶囊录制新键（冲突检测 + 恢复默认）。
 * - useCanvasKeyboard 每次 keydown 用 resolveActionId() 反查动作执行。
 * - 固定键（Esc/方向键/Space/Alt拖动/全局 Ctrl+S·O·N）不可自定义：列在 FIXED_KEYS
 *   供设置面板展示，组合串进 RESERVED_COMBOS 防用户占用。
 */

export interface KeymapAction {
  id: string;
  /** 设置面板显示名 */
  label: string;
  /** 分组标题：编辑 / 选择与分组 / 运行 / 视图 / 节点 */
  category: string;
  /** 默认组合键（规范化串） */
  def: string;
  /** 悬停说明 */
  desc?: string;
}

export const KEYMAP_ACTIONS: KeymapAction[] = [
  // ── 编辑 ──
  { id: "copy", label: "复制", category: "编辑", def: "ctrl+c", desc: "精准复制：选中节点 + 选中集内部连线（不带上游）" },
  { id: "superCopy", label: "全能复制", category: "编辑", def: "ctrl+shift+c", desc: "复制节点 + 内部连线 + 上游连线；粘贴时自动把原上游接回克隆体" },
  { id: "paste", label: "粘贴", category: "编辑", def: "ctrl+v", desc: "粘贴到屏幕中央" },
  { id: "undo", label: "撤销", category: "编辑", def: "ctrl+z" },
  { id: "redo", label: "重做", category: "编辑", def: "ctrl+y", desc: "Ctrl+Shift+Z 恒为重做别名（不占用本绑定）" },
  { id: "deleteNode", label: "删除节点/连线", category: "编辑", def: "delete", desc: "删除选中/聚焦节点与框选中的连线；绑定为 Delete 键时在节点面板内编辑中也可删" },
  // ── 选择与分组 ──
  { id: "selectAll", label: "全选", category: "选择与分组", def: "ctrl+a" },
  { id: "group", label: "合并打组", category: "选择与分组", def: "ctrl+g", desc: "多选 ≥2 个节点时生效" },
  { id: "ungroup", label: "解除打组", category: "选择与分组", def: "ctrl+shift+g", desc: "选中的分组容器 + 组内节点所属的组全部解散" },
  // ── 运行 ──
  { id: "runSelected", label: "运行节点", category: "运行", def: "ctrl+enter", desc: "运行选中节点（多选=全部启动；无选中跑面板聚焦节点）" },
  // ── 视图 ──
  { id: "zoomIn", label: "放大", category: "视图", def: "ctrl+=" },
  { id: "zoomOut", label: "缩小", category: "视图", def: "ctrl+-" },
  { id: "fitView", label: "适配全图", category: "视图", def: "ctrl+0" },
  // ── 节点 ──
  { id: "toggleStack", label: "打开/收起堆叠", category: "节点", def: "c", desc: "选中的图片/视频节点（有结果即可）展开抽屉；再按收起" },
];

/** 固定键（不可自定义，设置面板只读展示） */
export const FIXED_KEYS: { keys: string; label: string }[] = [
  { keys: "Esc", label: "关右键菜单 → 关堆叠抽屉 → 清选区/关面板" },
  { keys: "↑ ↓ ← →", label: "平移画布（Shift=大步；焦点在节点上时=微移节点）" },
  { keys: "Space 长按", label: "左键拖动平移画布" },
  { keys: "中键 / 右键拖动", label: "平移画布（按下滚轮拖动与右键拖动同效）" },
  { keys: "Alt+拖动节点", label: "拖动复制（原位留克隆，含内部+上游连线）" },
  { keys: "Ctrl+Shift+Z", label: "重做（别名，恒生效）" },
  { keys: "Ctrl+S / O / N", label: "保存 / 打开 / 新建项目（全局）" },
  { keys: "双击节点", label: "打开节点面板（单击=只选中）" },
];

/** 保留组合键：固定功能/系统占用，录制时拒绝分配 */
export const RESERVED_COMBOS = new Set<string>([
  "escape", "space",
  "arrowup", "arrowdown", "arrowleft", "arrowright",
  "shift+arrowup", "shift+arrowdown", "shift+arrowleft", "shift+arrowright",
  "ctrl+s", "ctrl+o", "ctrl+n", "ctrl+shift+z",
  "f5", "f11", "f12",
]);

/**
 * 从键盘事件构造规范化组合串；纯修饰键按下返回 null。
 * "+"/"_" 归一为 "="/"-"（Shift 产生的符号，丢弃 shift 修饰，兼容 Ctrl+Shift+= 与数字键盘 +）。
 */
export function comboFromEvent(e: KeyboardEvent): string | null {
  const raw = e.key;
  if (raw === "Control" || raw === "Shift" || raw === "Alt" || raw === "Meta") return null;
  let key = raw === " " ? "space" : raw.toLowerCase();
  let dropShift = false;
  if (key === "+") { key = "="; dropShift = true; }
  if (key === "_") { key = "-"; dropShift = true; }
  const mods: string[] = [];
  if (e.ctrlKey || e.metaKey) mods.push("ctrl");
  if (e.altKey) mods.push("alt");
  if (e.shiftKey && !dropShift) mods.push("shift");
  return [...mods, key].join("+");
}

/** 组合串 → 显示文案："ctrl+shift+c" → "Ctrl+Shift+C" */
export function comboLabel(combo: string): string {
  const NAMES: Record<string, string> = {
    ctrl: "Ctrl", alt: "Alt", shift: "Shift",
    escape: "Esc", delete: "Delete", enter: "Enter", space: "Space",
    backspace: "Backspace", tab: "Tab",
    arrowup: "↑", arrowdown: "↓", arrowleft: "←", arrowright: "→",
  };
  return combo
    .split("+")
    .map((p) => NAMES[p] ?? (p.length === 1 ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1)))
    .join("+");
}

/** 某动作的生效绑定（用户覆盖 > 默认） */
export function effectiveBinding(id: string, overrides: Record<string, string>): string {
  const act = KEYMAP_ACTIONS.find((a) => a.id === id);
  return overrides[id] ?? act?.def ?? "";
}

// combo→actionId 反查表：按 overrides 对象引用缓存（keydown 高频调用免重建）
let _cacheRef: Record<string, string> | null = null;
let _cacheMap: Map<string, string> = new Map();

/** 反查组合键对应的动作 id；未命中返回 null。"ctrl+shift+z" 恒为重做别名（用户未占用时）。 */
export function resolveActionId(combo: string, overrides: Record<string, string>): string | null {
  if (overrides !== _cacheRef) {
    _cacheMap = new Map();
    for (const a of KEYMAP_ACTIONS) {
      const b = overrides[a.id] ?? a.def;
      if (b && !_cacheMap.has(b)) _cacheMap.set(b, a.id);
    }
    _cacheRef = overrides;
  }
  const hit = _cacheMap.get(combo);
  if (hit) return hit;
  if (combo === "ctrl+shift+z") return "redo"; // 固定别名
  return null;
}
