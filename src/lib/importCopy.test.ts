import { describe, it, expect } from "vitest";
import { localRefOf, collectLocalRefs, applyRefRewrites, fileNameOf } from "./importCopy";

describe("importCopy · fileNameOf", () => {
	it("两种分隔符都取到文件名", () => {
		expect(fileNameOf("D:\\proj\\assets\\C00000123.png")).toBe("C00000123.png");
		expect(fileNameOf("D:/proj/assets/C00000123.png")).toBe("C00000123.png");
		expect(fileNameOf("")).toBe("");
	});
});

describe("importCopy · localRefOf", () => {
	it("webview 伪域直链（convertFileSrc Win 产物）→ 解码出本地路径，kind=uri", () => {
		const r = localRefOf("http://asset.localhost/D%3A%5Cproj%5Cassets%5CC00000123.png");
		expect(r).not.toBeNull();
		expect(r!.path).toBe("D:\\proj\\assets\\C00000123.png");
		expect(r!.kind).toBe("uri");
	});

	it("asset:// 直链（其它平台产物）→ kind=uri", () => {
		const r = localRefOf("asset://localhost/D%3A%2Fproj%2Fassets%2Fv.mp4");
		expect(r).not.toBeNull();
		expect(r!.path).toBe("D:/proj/assets/v.mp4");
		expect(r!.kind).toBe("uri");
	});

	it("裸 Windows 绝对路径（盘符/正反斜杠/UNC）→ kind=path", () => {
		expect(localRefOf("E:\\a\\assets\\S00000001.png")).toMatchObject({ kind: "path" });
		expect(localRefOf("D:/x/y.png")).toMatchObject({ kind: "path" });
		expect(localRefOf("\\\\nas\\share\\v.mp4")).toMatchObject({ kind: "path" });
	});

	it("真公网 url / 服务端 raw / data / blob / 路由串 / 相对串一律不认", () => {
		expect(localRefOf("https://oss.example.com/C00000123.png")).toBeNull(); // 公网 OSS 绝不能当本地
		expect(localRefOf("http://localhost:8787/v1/assets/C1/raw")).toBeNull();
		expect(localRefOf("data:image/png;base64,AAAA")).toBeNull();
		expect(localRefOf("blob:http://tauri.localhost/abc")).toBeNull();
		expect(localRefOf("/frame1693")).toBeNull(); // uiSnapshot 路由串
		expect(localRefOf("张三在奔跑")).toBeNull();
		expect(localRefOf("")).toBeNull();
	});

	it("超长文本（剧本/提示词）直接排除", () => {
		expect(localRefOf("C:\\" + "a".repeat(3000))).toBeNull();
	});
});

describe("importCopy · collectLocalRefs / applyRefRewrites", () => {
	it("深度收集：嵌套对象/数组、同串去重、公网 url 不收", () => {
		const data = {
			files: { f1: "D:\\p\\assets\\C1.png", f2: null },
			blobs: {
				b1: { localPath: "D:\\p\\assets\\C1.png", localUri: "http://asset.localhost/D%3A%5Cp%5Cassets%5CC1.png", url: "https://oss.example.com/C1.png" },
			},
			shots: [{ videoUris: ["D:/p/assets/video00000001.mp4"] }],
			ui: { route: "/frame1693" },
		};
		const refs = collectLocalRefs(data);
		expect(refs.size).toBe(3); // 裸路径（两处同串算一条）+ localUri + 视频路径
		expect(refs.has("D:\\p\\assets\\C1.png")).toBe(true);
		expect(refs.has("https://oss.example.com/C1.png")).toBe(false);
	});

	it("按映射整串改写（就地）、逐处计数、未命中原样", () => {
		const data = {
			a: "D:\\old\\C1.png",
			b: ["D:\\old\\C1.png", "keep-me"],
			c: { d: "http://asset.localhost/old", e: 42 },
		};
		const n = applyRefRewrites(data, new Map([
			["D:\\old\\C1.png", "E:\\new\\assets\\C1.png"],
			["http://asset.localhost/old", "http://asset.localhost/new"],
		]));
		expect(n).toBe(3); // 同串两处 + uri 一处
		expect(data.a).toBe("E:\\new\\assets\\C1.png");
		expect(data.b).toEqual(["E:\\new\\assets\\C1.png", "keep-me"]);
		expect(data.c.d).toBe("http://asset.localhost/new");
		expect(data.c.e).toBe(42);
	});

	it("空映射零开销原样返回", () => {
		const data = { a: "D:\\old\\C1.png" };
		expect(applyRefRewrites(data, new Map())).toBe(0);
		expect(data.a).toBe("D:\\old\\C1.png");
	});
});
