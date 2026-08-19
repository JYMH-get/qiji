import { describe, it, expect } from "vitest";
import {
	messageChars,
	sessionContextChars,
	formatConversation,
	JY_WARN_CHARS,
	JY_BLOCK_CHARS,
	SUMMARY_TEMPLATE_ID,
	HANDOFF_TEMPLATE_ID,
} from "./jianyiContext";
import type { JyMessage } from "@/store/jianyiAssistantStore";

function msg(role: "user" | "assistant", content: string, extra?: Partial<JyMessage>): JyMessage {
	return { id: `${role}-${Math.random()}`, role, content, timestamp: 0, ...extra };
}

describe("jianyiContext 上下文计数", () => {
	it("阈值常量符合定稿（6万提示 / 8万封锁）", () => {
		expect(JY_WARN_CHARS).toBe(60000);
		expect(JY_BLOCK_CHARS).toBe(80000);
	});

	it("两个动作的模板 id 与服务端补种一致", () => {
		expect(SUMMARY_TEMPLATE_ID).toBe("jianyi.summary");
		expect(HANDOFF_TEMPLATE_ID).toBe("jianyi.handoff");
	});

	it("messageChars 计 正文 + 可读附件正文", () => {
		const m = msg("user", "abc", {
			files: [
				{ url: "u", name: "a.txt", text: "12345" },
				{ url: "u2", name: "b.bin" }, // 二进制无正文不计
			],
		});
		expect(messageChars(m)).toBe(3 + 5);
	});

	it("sessionContextChars 累加全部消息", () => {
		const msgs = [msg("user", "aa"), msg("assistant", "bbbb")];
		expect(sessionContextChars(msgs)).toBe(6);
	});
});

describe("formatConversation 转录（完整发送，不采样——采样在服务端）", () => {
	it("按 用户/助手 拼接并内联附件正文", () => {
		const msgs = [
			msg("user", "问题", { files: [{ url: "u", name: "f.txt", text: "正文" }] }),
			msg("assistant", "回答"),
		];
		const t = formatConversation(msgs);
		expect(t).toContain("用户：问题");
		expect(t).toContain("【附件：f.txt】\n正文\n【附件结束】");
		expect(t).toContain("助手：回答");
	});

	it("超长会话原样完整转录（客户端零截断零省略标注）", () => {
		const long = "内容".repeat(50000); // 10 万字
		const t = formatConversation([msg("user", long)]);
		expect(t.length).toBe("用户：".length + long.length);
		expect(t).not.toContain("此处省略");
	});
});
