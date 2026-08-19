/**
 * stampLibrary —— 标注「纹章」的本机自定义章库（localStorage）。
 *
 * 自定义 PNG 章以 dataURL 存本机（章库=设备级工具配置，与项目无关）；
 * 标注 doc 里只存 stampId 引用，**绝不把 base64 写进项目文件**（§7.1 教训）。
 * 盖章导出时图像已烙进合成图；跨设备再编辑缺章仅显示占位框，属已知边界。
 */

export interface CustomStamp {
	id: string;
	name: string;
	dataUrl: string; // data:image/png;base64,...
}

const KEY = "Qiji:annoStamps";
const MAX_ONE = 2 * 1024 * 1024; // 单章 dataURL ≤2MB
const MAX_TOTAL = 8 * 1024 * 1024; // 章库总量 ≤8MB（localStorage 预算内）

export function listCustomStamps(): CustomStamp[] {
	try {
		const raw = localStorage.getItem(KEY);
		if (!raw) return [];
		const arr = JSON.parse(raw);
		if (!Array.isArray(arr)) return [];
		return arr.filter(
			(s): s is CustomStamp =>
				!!s && typeof s.id === "string" && typeof s.name === "string" &&
				typeof s.dataUrl === "string" && s.dataUrl.startsWith("data:image/"),
		);
	} catch {
		return [];
	}
}

/** 新增自定义章；超限返回错误文案（null=成功） */
export function addCustomStamp(name: string, dataUrl: string): { stamp?: CustomStamp; error?: string } {
	if (!dataUrl.startsWith("data:image/")) return { error: "仅支持图片文件" };
	if (dataUrl.length > MAX_ONE) return { error: "图片过大（超过 2MB），请压缩后再添加" };
	const list = listCustomStamps();
	const total = list.reduce((s, x) => s + x.dataUrl.length, 0) + dataUrl.length;
	if (total > MAX_TOTAL) return { error: "章库容量已满（8MB），请先删除一些旧章" };
	const stamp: CustomStamp = {
		id: `st-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
		name: (name || "自定义章").slice(0, 24),
		dataUrl,
	};
	try {
		localStorage.setItem(KEY, JSON.stringify([...list, stamp]));
	} catch {
		return { error: "保存失败（本地存储空间不足）" };
	}
	return { stamp };
}

export function removeCustomStamp(id: string): void {
	try {
		localStorage.setItem(KEY, JSON.stringify(listCustomStamps().filter((s) => s.id !== id)));
	} catch { /* 删除失败无害，下次读取原样 */ }
}
