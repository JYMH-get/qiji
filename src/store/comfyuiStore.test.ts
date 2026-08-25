/** ComfyUI 多端点绑定：持久化解析/迁移 + 负载择优 + /queue 回执严格判定 纯函数测试 */
import { describe, it, expect } from "vitest";
import { normalizeComfyuiUrl, parseComfyPersist, chooseComfyEndpointId, queueLoadOf } from "./comfyuiStore";

describe("normalizeComfyuiUrl", () => {
	it("无协议补 http://、去尾斜杠", () => {
		expect(normalizeComfyuiUrl("127.0.0.1:8188/")).toBe("http://127.0.0.1:8188");
		expect(normalizeComfyuiUrl("https://xx.gpuhub.com:12345//")).toBe("https://xx.gpuhub.com:12345");
	});
	it("空/纯空白 → 空串", () => {
		expect(normalizeComfyuiUrl("")).toBe("");
		expect(normalizeComfyuiUrl("   ")).toBe("");
	});
});

describe("parseComfyPersist（读盘 + 第250轮单地址迁移）", () => {
	it("新形态：清洗归一、空 url 丢弃、重复地址去重、缺 id 补齐", () => {
		const eps = parseComfyPersist(JSON.stringify({
			endpoints: [
				{ id: "a", url: "127.0.0.1:8188/", name: "本机" },
				{ url: "http://b.host:8188", enabled: false },
				{ id: "c", url: "" },
				{ id: "d", url: "http://127.0.0.1:8188" }, // 与第一条归一后重复
			],
		}));
		expect(eps).toHaveLength(2);
		expect(eps[0]).toMatchObject({ id: "a", url: "http://127.0.0.1:8188", name: "本机", enabled: true });
		expect(eps[1].url).toBe("http://b.host:8188");
		expect(eps[1].enabled).toBe(false);
		expect(eps[1].id).toBeTruthy(); // 缺 id 自动补
		expect(eps[1].name).toBe("http://b.host:8188"); // 缺名=地址
	});
	it("第250轮旧形态 { url } → 单端点（名「默认」、启用）", () => {
		const eps = parseComfyPersist(JSON.stringify({ url: "http://127.0.0.1:8188" }));
		expect(eps).toHaveLength(1);
		expect(eps[0]).toMatchObject({ url: "http://127.0.0.1:8188", name: "默认", enabled: true });
	});
	it("旧形态空 url / 坏 JSON / null → 空列表", () => {
		expect(parseComfyPersist(JSON.stringify({ url: "" }))).toEqual([]);
		expect(parseComfyPersist("{bad json")).toEqual([]);
		expect(parseComfyPersist(null)).toEqual([]);
	});
});

describe("chooseComfyEndpointId（最小负载择优 + 平手轮转）", () => {
	const cands = [
		{ id: "a", load: 2 },
		{ id: "b", load: 0 },
		{ id: "c", load: 0 },
	];
	it("取负载最小者", () => {
		expect(chooseComfyEndpointId([{ id: "x", load: 3 }, { id: "y", load: 1 }], 0)).toBe("y");
	});
	it("平手按游标在并列者间轮流（b、c 交替）", () => {
		expect(chooseComfyEndpointId(cands, 0)).toBe("b");
		expect(chooseComfyEndpointId(cands, 1)).toBe("c");
		expect(chooseComfyEndpointId(cands, 2)).toBe("b");
	});
	it("空候选 → null；单候选恒选它", () => {
		expect(chooseComfyEndpointId([], 5)).toBeNull();
		expect(chooseComfyEndpointId([{ id: "only", load: 9 }], 7)).toBe("only");
	});
});

describe("queueLoadOf（/queue 回执严格判定——关机实例的 200 提示页不得判活）", () => {
	it("正常回执 → 在跑+排队求和；缺一个数组按 0 计", () => {
		expect(queueLoadOf({ queue_running: [1], queue_pending: [1, 2] })).toBe(3);
		expect(queueLoadOf({ queue_running: [] })).toBe(0);
	});
	it("非 ComfyUI 形状（null/无队列数组的对象）→ null 判死", () => {
		expect(queueLoadOf(null)).toBeNull(); // HTML 提示页 = JSON 解析失败 = body null
		expect(queueLoadOf({ message: "instance stopped" })).toBeNull();
		expect(queueLoadOf({ queue_running: "oops" })).toBeNull();
	});
});
