import { describe, it, expect, beforeEach } from "vitest";
import { healLibraryAssets } from "./libraryHeal";
import { useLibraryStore, type Asset } from "@/store/libraryStore";
import { useProjectStore } from "@/store/projectStore";

// 第145轮：素材库显示自愈（非 Tauri 路径——vitest node 环境天然覆盖浏览器分支；
// Tauri 分支（exists/convertFileSrc/saveRemoteAsset 下载）走真机 QA）

function libAsset(p: Partial<Asset>): Asset {
	return {
		id: "x", kind: "image", name: "x.png", uri: "", thumbnailUri: null,
		createdAt: "2026-07-21T00:00:00.000Z", deletedByUser: false, origin: "upload",
		...p,
	};
}

beforeEach(() => {
	useLibraryStore.setState({ assets: {} });
	useProjectStore.setState({ assetBlobs: {}, isDirty: false });
});

describe("healLibraryAssets", () => {
	it("死 blob: uri → 凭三元映射 localUri 换源（asset.localhost 本地显示态）", async () => {
		useProjectStore.setState({
			assetBlobs: { TP1: { id: "TP1", url: "https://oss/1.png", localUri: "http://asset.localhost/E:/p/assets/TP1.png" } },
		});
		useLibraryStore.setState({
			assets: { TP1: libAsset({ id: "TP1", serverAssetId: "TP1", uri: "blob:http://tauri.localhost/dead" }) },
		});
		expect(await healLibraryAssets()).toBe(1);
		expect(useLibraryStore.getState().assets.TP1.uri).toBe("http://asset.localhost/E:/p/assets/TP1.png");
		expect(useProjectStore.getState().isDirty).toBe(true); // 自愈结果随下次保存持久化
	});

	it("死 blob: 无 localUri → 非 Tauri 换公网 url", async () => {
		useProjectStore.setState({ assetBlobs: { TP2: { id: "TP2", url: "https://oss/2.png" } } });
		useLibraryStore.setState({
			assets: { TP2: libAsset({ id: "TP2", serverAssetId: "TP2", uri: "blob:http://tauri.localhost/dead2" }) },
		});
		expect(await healLibraryAssets()).toBe(1);
		expect(useLibraryStore.getState().assets.TP2.uri).toBe("https://oss/2.png");
	});

	it("健康的本地显示态不动；无任何线索的保持原样（不编造）；已删除的跳过", async () => {
		useLibraryStore.setState({
			assets: {
				ok: libAsset({ id: "ok", uri: "http://asset.localhost/E:/p/assets/ok.png" }),
				lost: libAsset({ id: "lost", uri: "blob:http://tauri.localhost/dead3" }), // 无映射无 url
				del: libAsset({ id: "del", uri: "blob:http://tauri.localhost/dead4", deletedByUser: true }),
			},
		});
		expect(await healLibraryAssets()).toBe(0);
		const s = useLibraryStore.getState().assets;
		expect(s.ok.uri).toBe("http://asset.localhost/E:/p/assets/ok.png");
		expect(s.lost.uri).toBe("blob:http://tauri.localhost/dead3");
		expect(useProjectStore.getState().isDirty).toBe(false);
	});

	it("浏览器下远程 https uri 本就可显示：不动", async () => {
		useLibraryStore.setState({
			assets: { r: libAsset({ id: "r", uri: "https://oss/r.png" }) },
		});
		expect(await healLibraryAssets()).toBe(0);
		expect(useLibraryStore.getState().assets.r.uri).toBe("https://oss/r.png");
	});
});
