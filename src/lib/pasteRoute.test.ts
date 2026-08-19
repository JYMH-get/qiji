/**
 * pasteRoute —— 画布 Ctrl+V 分流判定（第113轮锁定）：
 *  内部节点粘贴优先的三判据（标记命中 / 剪贴板为空 / 复制后未离开窗口），
 *  否则 媒体文件 > 纯文字 > 无动作。
 */
import { describe, it, expect } from "vitest";
import { pasteRoute, NODE_COPY_MARKER } from "./pasteRoute";

const base = { text: "", fileCount: 0, hasInternalNodes: false, copiedAt: 0, blurAt: 0 };

describe("pasteRoute 粘贴分流", () => {
	it("标记命中 → 内部粘贴（即使同项还带着我们写入的 PNG 文件）", () => {
		expect(pasteRoute({ ...base, hasInternalNodes: true, text: NODE_COPY_MARKER, fileCount: 1 })).toBe("internal");
	});

	it("系统剪贴板为空 + 有内部节点 → 内部粘贴", () => {
		expect(pasteRoute({ ...base, hasInternalNodes: true })).toBe("internal");
	});

	it("复制节点后未离开窗口（copiedAt > blurAt）→ 内部粘贴兜底（标记写失败时系统剪贴板是陈旧外部内容）", () => {
		expect(pasteRoute({ ...base, hasInternalNodes: true, text: "陈旧外部文字", copiedAt: 2000, blurAt: 1000 })).toBe("internal");
	});

	it("离开过窗口后回来（blurAt > copiedAt）+ 外部图片 → 建图片节点（外部截图优先于陈旧内部复制）", () => {
		expect(pasteRoute({ ...base, hasInternalNodes: true, fileCount: 1, text: "", copiedAt: 1000, blurAt: 2000 })).toBe("files");
	});

	it("外部文字（无内部剪贴板）→ 文本节点；空白文字不建节点", () => {
		expect(pasteRoute({ ...base, text: "一段剧本原文" })).toBe("text");
		expect(pasteRoute({ ...base, text: "   \n " })).toBe("none");
	});

	it("外部媒体文件（无内部剪贴板）→ 导入文件；文件与文字并存时文件优先", () => {
		expect(pasteRoute({ ...base, fileCount: 2 })).toBe("files");
		expect(pasteRoute({ ...base, fileCount: 1, text: "配文" })).toBe("files");
	});

	it("什么都没有 → none", () => {
		expect(pasteRoute(base)).toBe("none");
	});
});
