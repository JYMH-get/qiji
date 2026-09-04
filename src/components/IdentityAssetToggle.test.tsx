import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { IdentityAssetToggle } from "./IdentityAssetToggle";

describe("IdentityAssetToggle", () => {
	it("固定在人像素材卡右下角，不占用右上角删除位", () => {
		const html = renderToStaticMarkup(<IdentityAssetToggle active onToggle={vi.fn()} />);

		expect(html).toContain("right:1px");
		expect(html).toContain("bottom:1px");
		expect(html).not.toContain("top:");
		expect(html).not.toContain("left:");
		expect(html).toContain("aria-pressed=\"true\"");
		expect(html).toContain("人✓");
	});
});
