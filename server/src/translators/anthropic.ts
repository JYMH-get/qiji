/**
 * Claude（Anthropic）文本翻译器（真）。
 *
 * 结构化输出走 CLAUDE.md 锁定的方案：tool-use 强制。
 * 把 catalog 的输出 schema 当作一个工具的 input_schema，用 tool_choice 强制模型
 * 必须调用该工具，再从 tool_use 块的 input 取回已按 schema 约束的 JSON。
 * 纯文本则普通 messages 调用取 text。
 *
 * 用官方 SDK @anthropic-ai/sdk（自动处理 x-api-key / anthropic-version 头）。
 */
import Anthropic from "@anthropic-ai/sdk";
import { getSchema } from "../catalog.ts";
import { maskToken } from "../store/logs.ts";
import { buildPrompt, collectImageUrls } from "./prompt.ts";
import type { SyncResult, OnDelta, OnUpstream } from "./openai.ts";
import type { Upstream } from "./upstream.ts";
import type { GenerateRequest } from "../contract.ts";

const MAX_TOKENS = 16000;
/** 客户端总超时放宽到 20 分钟（SDK 流式会自动保活；长任务靠流式而非提高单次阻塞时长） */
const CLIENT_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * Claude 文本翻译器（真，SDK 流式）。
 * 文本：messages.stream + on("text") 累积，规避长任务断连、可回传部分正文。
 * 结构化：tool-use 强制 + 流式 finalMessage 取 tool_use.input。
 */
export async function translateAnthropicText(req: GenerateRequest, up: Upstream, onDelta?: OnDelta, onUpstream?: OnUpstream): Promise<SyncResult> {
	if (!up.apiKey) {
		return { status: "failed", error: "该模型未配置上游密钥（管理端模型设置或网关 GATEWAY_API_KEY），可改用 echo-text 联调" };
	}

	// 网关用 Authorization: Bearer（非官方 x-api-key），故走 authToken
	const client = new Anthropic({ authToken: up.apiKey, baseURL: up.baseUrl, timeout: CLIENT_TIMEOUT_MS, maxRetries: 1 });
	const model = up.upstreamModel;
	const prompt = buildPrompt(req);
	const wantJson = req.output?.format === "json";
	// 多模态：携带图片时用户消息内容用 [text + image(url)...] 块；无图则纯文本字符串
	const imageUrls = collectImageUrls(req);
	const userContent: Anthropic.MessageParam["content"] = imageUrls.length
		? [
				{ type: "text", text: prompt },
				...imageUrls.map((u) => ({ type: "image" as const, source: { type: "url" as const, url: u } })),
		  ]
		: prompt;
	onUpstream?.({ request: { baseUrl: up.baseUrl, method: "POST(SDK messages.stream)", headers: { Authorization: `Bearer ${maskToken(up.apiKey)}`, "anthropic-version": "(SDK 默认)" }, model, wantJson, schemaId: req.output?.schemaId, messages: [{ role: "user", content: prompt }] } });

	try {
		// 结构化输出：tool-use 强制（流式累积后取 finalMessage 的 tool_use）
		if (wantJson) {
			const schema = req.output?.schemaId ? getSchema(req.output.schemaId) : undefined;
			if (!schema) {
				return { status: "failed", error: `未找到输出 schema：${req.output?.schemaId ?? "(空)"}` };
			}
			const toolName = `emit_${(req.output!.schemaId ?? "output").replace(/[^A-Za-z0-9_]/g, "_")}`;
			const stream = client.messages.stream({
				model,
				max_tokens: MAX_TOKENS,
				messages: [{ role: "user", content: userContent }],
				tools: [
					{
						name: toolName,
						description: "按给定 schema 输出结构化结果。必须调用本工具一次，把结果放入入参。",
						input_schema: schema as Anthropic.Tool["input_schema"],
					},
				],
				tool_choice: { type: "tool", name: toolName },
			});
			const final = await stream.finalMessage();
			const toolUse = final.content.find((b) => b.type === "tool_use");
			if (toolUse && toolUse.type === "tool_use") {
				onUpstream?.({ response: { stop_reason: final.stop_reason, tool_use: toolUse.input } });
				return { status: "success", result: { json: toolUse.input, text: JSON.stringify(toolUse.input) } };
			}
			return { status: "failed", error: "Claude 未返回 tool_use 结构化结果" };
		}

		// 纯文本：流式累积
		let text = "";
		const stream = client.messages.stream({
			model,
			max_tokens: MAX_TOKENS,
			messages: [{ role: "user", content: userContent }],
		});
		stream.on("text", (delta: string) => {
			text += delta;
			onDelta?.(text);
		});
		const final = await stream.finalMessage();
		const full = final.content
			.filter((b) => b.type === "text")
			.map((b) => (b.type === "text" ? b.text : ""))
			.join("");
		onUpstream?.({ response: { stop_reason: final.stop_reason, text: full || text } });
		return { status: "success", result: { text: full || text } };
	} catch (err) {
		const e = err as { status?: number; message?: string };
		onUpstream?.({ response: { error: e.message ?? String(err) } });
		return { status: "failed", error: `Claude 调用失败：${e.message ?? String(err)}` };
	}
}
