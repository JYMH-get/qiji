/**
 * assetVars —— 构建喂给提示词模板的「资产列表」变量（角色/场景/物品/生物/群像）。
 *
 * 与资产拆分（Frame1693）同格式：每条 = 编号 + 名称 +（变体标签），供智能推理 / 智能拆分等模板的
 * `{{角色列表}}`/`{{场景列表}}`/`{{物品列表}}`/`{{生物列表}}`/`{{群像列表}}` 占位填充，
 * 让模型按项目既有资产名输出 `{角色:名}`/`{场景:名}` 等代码公式（不另起炉灶造新名）。
 *
 * 模板未引用这些占位也无副作用（fillTemplate 忽略未用变量）。
 */
import { useProjectStore } from "@/store/projectStore";

function codeFromId(id: string): string {
	const m = String(id || "").match(/^([A-Za-z]+\d+[A-Za-z]*)/); // "C01-<ts>-<n>" → "C01"
	return m ? m[1] : "";
}
function compactAssetLine(a: any): string {
	const code = codeFromId(a.id);
	const vs = Array.isArray(a.variants) && a.variants.length
		? `（变体: ${a.variants.map((v: any) => v.label || v.name).filter(Boolean).join(" / ")}）`
		: "";
	return `${[code, a.name].filter(Boolean).join(" ")}${vs}`;
}
function fmt(arr: any[] | undefined, empty: string): string {
	return !arr || arr.length === 0 ? empty : arr.map(compactAssetLine).join("、");
}

/** 当前项目的资产列表变量（角色/场景/物品/生物/群像），用于模板占位填充 */
export function buildAssetListVars(): Record<string, string> {
	const s = useProjectStore.getState();
	return {
		角色列表: fmt(s.characters, "无角色数据"),
		场景列表: fmt(s.scenes, "无场景数据"),
		物品列表: fmt(s.items, "无物品/道具数据"),
		生物列表: fmt(s.organisms, "无生物数据"),
		群像列表: fmt(s.crowds, "无群像数据"),
	};
}
