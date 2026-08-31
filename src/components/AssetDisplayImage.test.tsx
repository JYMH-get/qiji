import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/nodes/ResultView", () => ({
	useDisplayUri: (uri?: string | null) => uri === "https://old.example/asset.png"
		? "asset://restored/asset.png"
		: (uri || ""),
}));

import { AssetDisplayImage } from "./AssetDisplayImage";

describe("AssetDisplayImage", () => {
	it("资产页图片统一使用三元映射恢复后的显示地址", () => {
		const html = renderToStaticMarkup(
			<AssetDisplayImage uri="https://old.example/asset.png" alt="镇北侯府嫡女" />,
		);
		expect(html).toContain('src="asset://restored/asset.png"');
		expect(html).not.toContain("https://old.example/asset.png");
	});

	it("Tauri 恢复远程图片期间显示恢复进度且不创建 img", () => {
		vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
		try {
			const html = renderToStaticMarkup(
				<AssetDisplayImage uri="https://pending.example/asset.png" alt="待恢复图片" recovery="bar" />,
			);
			expect(html).toContain("正在从服务端恢复图片");
			expect(html).toContain("<progress");
			expect(html).not.toContain("<img");
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
