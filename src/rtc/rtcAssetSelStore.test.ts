/**
 * rtcAssetSelStore 项目隔离单测：cat+id / 媒体卡 key+uri 只在所属项目内有意义，
 * 项目切换（projectInstanceId 变化）必须清空选中，防跨项目串显同位资产。
 */
import { describe, expect, it } from "vitest";
import { useProjectStore } from "@/store/projectStore";
import { useRtcAssetSelStore } from "./rtcAssetSelStore";

describe("rtcAssetSelStore 项目切换清空", () => {
	it("projectInstanceId 变化 → selected 与 mediaSel 一并清空", () => {
		useProjectStore.setState({ projectInstanceId: "pi-sel-A" });
		useRtcAssetSelStore.getState().select({ cat: "characters", id: "c1" });
		expect(useRtcAssetSelStore.getState().selected).toEqual({ cat: "characters", id: "c1" });

		useProjectStore.setState({ projectInstanceId: "pi-sel-B" });
		expect(useRtcAssetSelStore.getState().selected).toBeNull();

		useRtcAssetSelStore.getState().toggleMedia({ key: "k1", uri: "http://x.localhost/v.mp4", media: "video", name: "v" });
		expect(useRtcAssetSelStore.getState().mediaSel?.key).toBe("k1");
		useProjectStore.setState({ projectInstanceId: "pi-sel-C" });
		expect(useRtcAssetSelStore.getState().mediaSel).toBeNull();
	});

	it("同项目内其它 projectStore 变更不影响选中", () => {
		useProjectStore.setState({ projectInstanceId: "pi-sel-D" });
		useRtcAssetSelStore.getState().select({ cat: "scenes", id: "sc1" });
		useProjectStore.setState({ scriptText: "剧本改动" });
		expect(useRtcAssetSelStore.getState().selected).toEqual({ cat: "scenes", id: "sc1" });
	});
});
