import { describe, it, expect } from "vitest";
import { toPortableProjectData } from "./portableProject";
import type { QijiProject } from "@/services/projectFile";

/** 造一个含「有 url 的资产」+「纯本地无 url 的资产」的代表性项目 */
function makeProject(): QijiProject {
	return {
		version: "2.0",
		savedAt: "",
		name: "测试",
		coverImage: "data:image/webp;base64,AAAA", // 设备无关，应原样保留
		characters: [
			{ id: "c1", name: "张三", features: "", philosophy: "", prompt: "", image: "http://asset.localhost/D:/proj/assets/C001.png" },
			{ id: "c2", name: "李四", features: "", philosophy: "", prompt: "", image: "asset://localhost/E:/x/C002.png" }, // 无 url → 保留 + 计入 unresolved
		],
		episodes: [
			{ id: "e1", title: "第一集", script: "", shots: [{ id: "s1", index: 0, scriptContent: "", durationSec: 5, storyboardUri: "http://asset.localhost/D:/proj/assets/S001.png", videoUris: ["http://asset.localhost/D:/proj/assets/V001.mp4"] }] } as any,
		],
		genMeta: { "http://asset.localhost/D:/proj/assets/C001.png": { prompt: "画张三", refs: [], at: 1 } },
		assetBlobs: {
			C00001: { id: "C00001", url: "https://oss.example.com/qiji/u/p/C001.png", localPath: "D:/proj/assets/C001.png", localUri: "http://asset.localhost/D:/proj/assets/C001.png", mime: "image/png", ext: "png" },
			S00001: { id: "S00001", url: "https://oss.example.com/qiji/u/p/S001.png", localUri: "http://asset.localhost/D:/proj/assets/S001.png" },
			V00001: { id: "V00001", url: "https://oss.example.com/qiji/u/p/V001.mp4", localUri: "http://asset.localhost/D:/proj/assets/V001.mp4" },
			C00002: { id: "C00002", localUri: "asset://localhost/E:/x/C002.png" }, // 无 url
		},
	} as unknown as QijiProject;
}

describe("toPortableProjectData", () => {
	it("把本地引用改写成公网 url，保留设备无关内容，统计无 url 的资产", () => {
		const src = makeProject();
		const { data, unresolved } = toPortableProjectData(src);

		// 有 url 的资产：本地引用 → OSS url
		expect(data.characters![0].image).toBe("https://oss.example.com/qiji/u/p/C001.png");
		expect(data.episodes![0].shots![0].storyboardUri).toBe("https://oss.example.com/qiji/u/p/S001.png");
		expect(data.episodes![0].shots![0].videoUris![0]).toBe("https://oss.example.com/qiji/u/p/V001.mp4");

		// 无 url 的资产：保留原本地引用 + 计入 unresolved
		expect(data.characters![1].image).toBe("asset://localhost/E:/x/C002.png");
		expect(unresolved).toBe(1);

		// 设备无关内容（data: 封面）原样保留
		expect(data.coverImage).toBe("data:image/webp;base64,AAAA");

		// genMeta 的键（图片 uri）也被改写
		expect(data.genMeta!["https://oss.example.com/qiji/u/p/C001.png"]).toBeTruthy();
		expect(data.genMeta!["http://asset.localhost/D:/proj/assets/C001.png"]).toBeUndefined();

		// assetBlobs 剥掉本地路径、丢弃无 url 的 blob
		expect(data.assetBlobs!.C00001.localPath).toBeUndefined();
		expect(data.assetBlobs!.C00001.localUri).toBeUndefined();
		expect(data.assetBlobs!.C00001.url).toBe("https://oss.example.com/qiji/u/p/C001.png");
		expect(data.assetBlobs!.C00002).toBeUndefined();
	});

	it("不修改传入对象（返回深拷贝）", () => {
		const src = makeProject();
		toPortableProjectData(src);
		expect(src.characters![0].image).toBe("http://asset.localhost/D:/proj/assets/C001.png");
		expect(src.assetBlobs!.C00001.localPath).toBe("D:/proj/assets/C001.png");
	});
});
