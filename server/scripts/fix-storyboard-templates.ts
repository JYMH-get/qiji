/**
 * 一次性数据修复：
 * 1) 导入 store/templates 触发「补种缺失内置模板」——新增 storyboard.split.bigcard（智能拆分·大卡）
 *    与 storyboard.toimage.reason（故事板推理），并落盘 templates.json。
 * 2) 把用户自建的 fenjing（分镜推理）从 purpose=storyboard.split 改挂到 storyboard.toVideoPrompt，
 *    使其出现在「推理视频提示词」下拉、且不再抢占「智能拆分」默认；同时把正文里的
 *    {{历史资产}}/{{前文}} 占位归一为该用途客户端实际下发的 {{所需资产}}/{{前文上下文}}。
 *
 * 运行：cd server && npx tsx scripts/fix-storyboard-templates.ts
 */
import {
	listTemplates,
	getDefaultTemplate,
	getTemplateDef,
	updateTemplate,
} from "../src/store/templates.ts";

console.log("=== 模板修复前（storyboard.* 用途） ===");
for (const t of listTemplates()) {
	if (t.purpose?.startsWith("storyboard.")) {
		console.log(`  ${t.id} | ${t.name} | purpose=${t.purpose} | isDefault=${t.isDefault} | order=${t.order}`);
	}
}

const fj = getTemplateDef("fenjing");
if (fj) {
	const body = fj.body
		.replace(/\{\{\s*历史资产\s*\}\}/g, "{{所需资产}}")
		.replace(/\{\{\s*前文\s*\}\}/g, "{{前文上下文}}");
	updateTemplate("fenjing", {
		purpose: "storyboard.toVideoPrompt",
		category: "分镜生图",
		nodeTypes: ["script"],
		variables: ["原文", "所需资产", "前文上下文"],
		body,
	});
	console.log("\n[fixed] fenjing → purpose=storyboard.toVideoPrompt（占位归一 历史资产→所需资产 / 前文→前文上下文）");
} else {
	console.log("\n[skip] 未找到 fenjing 模板（可能已被删除/重命名）");
}

console.log("\n=== 各用途默认模板（getDefaultTemplate） ===");
for (const p of ["storyboard.split", "storyboard.toImagePrompt", "storyboard.toVideoPrompt"] as const) {
	const d = getDefaultTemplate(p);
	console.log(`  ${p} → ${d ? `${d.id}（${d.name}）` : "(无)"}`);
}

console.log("\n=== 修复后（storyboard.* 用途） ===");
for (const t of listTemplates()) {
	if (t.purpose?.startsWith("storyboard.")) {
		console.log(`  ${t.id} | ${t.name} | purpose=${t.purpose} | isDefault=${t.isDefault} | order=${t.order}`);
	}
}
