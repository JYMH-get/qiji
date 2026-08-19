/**
 * assetMerge —— 资产提取结果的**合并落库**（资产模式剧本页与画布资产拆分节点共用）。
 *
 * 原为 Frame1693 私有（第85轮抽出）：画布 asset.split 节点的结果也要走同一条入库链路
 * （单数据源：画布拆的资产同样进五类界面/分配编号/写视觉圣经），故提为共享模块。
 * 语义（锁定）：
 *  - 归属校验：仅当当前项目仍是发起时的项目（owner=projectInstanceId）才写库，杜绝跨项目串台；
 *  - 纯合并：以当前最新 store 为基准，按「名称→编号」匹配去重，保留已有资产的 id/已生成图片/变体，
 *    只新增缺失资产、并入新变体；绝不整体替换、绝不删旧资产；
 *  - 跨轮孤儿变体（父资产在上一轮）按父编号回挂，找不到父才退化为基础资产。
 */
import { useProjectStore } from "@/store/projectStore";
import { attachSplitPresets, type SplitAttachCat } from "@/lib/splitPresetAttach";
import type { VisualBible } from "@/lib/assetExtraction";

// 松类型：store 端各类资产字段不一（场景/道具用 description、variants 可选），合并只依赖 name + variants
export type AnyAsset = { name: string; variants?: any[]; [k: string]: any };
export type ExtractBuckets = { characters: AnyAsset[]; scenes: AnyAsset[]; items: AnyAsset[]; organisms: AnyAsset[]; crowds: AnyAsset[] };

/** 新增资产的出图提示词装饰钩子（第174轮：拆分前后缀预设化——mergeApply 传 attachSplitPresets） */
export type PromptDecorator = (cat: SplitAttachCat, prompt: string) => string;

/**
 * 续提合并：把新一轮结果并入现有资产。按「名称」在各类内去重——
 * 同名视为同一资产、不重复加入；同名时把新变体（按 label/name）并进已有资产。返回合并结果 + 实际新增数。
 * decoratePrompt（可选）：仅对**新增基础资产**的 prompt 生效（已有资产字段绝不覆盖的语义不变）。
 */
export function mergeExtraction(cur: ExtractBuckets, add: ExtractBuckets, decoratePrompt?: PromptDecorator): { merged: ExtractBuckets; addedCount: number } {
	let added = 0;
	// 资产编号：优先显式 code，否则从 id 前缀回收（旧资产 id = `C01-<ts>-<n>`）
	const codeOf = (x: AnyAsset) => String(x.code || String(x.id || "").split("-")[0] || "").toUpperCase();
	const parentCode = (c: string) => (c.match(/^([A-Za-z]+\d+)/) || [])[1] || c;
	const mergeCat = (a: AnyAsset[], b: AnyAsset[], catKey: SplitAttachCat): AnyAsset[] => {
		const out = a.map((x) => ({ ...x, variants: [...(x.variants || [])] }));
		const byName = new Map(out.map((x) => [String(x.name).trim(), x] as const));
		// 父编号 → 已有基础资产，供跨轮（继续提取）变体回挂
		const byParentCode = new Map<string, AnyAsset>();
		for (const x of out) { const c = codeOf(x); if (c) byParentCode.set(parentCode(c), x); }
		for (const nb of b) {
			// 跨轮孤儿变体（如 C01C，父 C01 在上一轮）——按父编号回挂到已有资产的 variants，避免误成基础资产
			if (nb.inheritsFrom) {
				const parent = byParentCode.get(String(nb.inheritsFrom).toUpperCase());
				if (parent) {
					const v = nb.variantPayload || { id: nb.id, label: "变体", name: nb.name, description: nb.features, prompt: nb.prompt, image: nb.image };
					if (!parent.variants) parent.variants = [];
					const seen = new Set(parent.variants.map((pv: any) => String(pv.label || pv.name).trim()));
					const key = String(v.label || v.name).trim();
					if (key && !seen.has(key)) { parent.variants.push(v); added++; }
					continue;
				}
				// 找不到父——退化为基础资产（剥掉变体标记，走下方常规合并）
				delete nb.inheritsFrom; delete nb.variantPayload;
			}
			const key0 = String(nb.name).trim();
			// 先按名称、再按编号匹配已有资产（用户可能改过名但编号不变；模型也可能名称略有出入）——
			// 命中即视为同一资产，仅并入新变体、不重复加入、不覆盖已有字段与已生成图片。
			const nbCode = codeOf(nb);
			const nbPCode = nbCode ? parentCode(nbCode) : "";
			const hit = byName.get(key0) || (nbPCode ? byParentCode.get(nbPCode) : undefined);
			if (!hit) {
				const nbN = { ...nb, variants: [...(nb.variants || [])] } as AnyAsset & { variants: any[] };
				// 第174轮：新增基础资产的出图提示词挂 画风前缀/类别前后缀 预设胶囊（已有资产不动）
				if (decoratePrompt && typeof nbN.prompt === "string") nbN.prompt = decoratePrompt(catKey, nbN.prompt);
				out.push(nbN); byName.set(key0, nbN); const c = codeOf(nbN); if (c) byParentCode.set(parentCode(c), nbN); added++; continue;
			}
			if (!hit.variants) hit.variants = [];
			const seen = new Set(hit.variants.map((v: any) => String(v.label || v.name).trim()));
			for (const nv of nb.variants || []) {
				const key = String(nv.label || nv.name).trim();
				if (key && !seen.has(key)) { hit.variants.push(nv); seen.add(key); added++; }
			}
		}
		return out;
	};
	return {
		merged: {
			characters: mergeCat(cur.characters, add.characters, "characters"),
			scenes: mergeCat(cur.scenes, add.scenes, "scenes"),
			items: mergeCat(cur.items, add.items, "items"),
			organisms: mergeCat(cur.organisms, add.organisms, "organisms"),
			crowds: mergeCat(cur.crowds, add.crowds, "crowds"),
		},
		addedCount: added,
	};
}

/**
 * 把一轮提取结果**合并落库**（防串台 + 防丢资产的统一出口）。
 * 流式刷新、最终结果、继续提取、断连恢复、画布拆分节点五条链路共用。
 * 返回 true=已落库；false=已切到别的项目、本次放弃。
 */
export function mergeApply(owner: string, add: ExtractBuckets, visualBible: VisualBible | undefined, time: string): boolean {
	const st = useProjectStore.getState();
	if (st.projectInstanceId !== owner) return false; // 用户已切换项目 → 放弃，避免串台
	const cur: ExtractBuckets = {
		characters: st.characters || [], scenes: st.scenes || [], items: st.items || [],
		organisms: st.organisms || [], crowds: st.crowds || [],
	};
	// 第174轮：新增资产的出图提示词自动挂 画风前缀 + 类别前后缀 预设胶囊（拆分前后缀不再依赖推理）
	const { merged } = mergeExtraction(cur, add, attachSplitPresets);
	st.setAnalysisResult({ ...merged, visualBible, time });
	return true;
}

/** 当前时间标签（与剧本页「最近分析时间」同格式） */
export function analysisTimeLabel(): string {
	const now = new Date();
	const p = (v: number) => String(v).padStart(2, "0");
	return `${now.getFullYear()}/${p(now.getMonth() + 1)}/${p(now.getDate())}   ${p(now.getHours())}:${p(now.getMinutes())}`;
}
