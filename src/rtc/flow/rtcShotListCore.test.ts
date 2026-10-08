import { describe, expect, it } from "vitest";
import type { StoryboardShot } from "@/services/projectFile";
import type { RtcDoc, RtcSegment } from "@/types/rtc";
import { rtcShotListRows } from "./rtcShotListCore";

const shots = ["a", "b", "c"].map((id, i) => ({ id, title: `分镜${i + 1}`, index: i + 1 }) as StoryboardShot);
const seg = (id: string, shotId: string, start = 0, episodeId = "ep"): RtcSegment => ({ id, kind: "placeholder", targetStartUs: start, targetDurationUs: 10, shotRef: { episodeId, shotId } });
const doc = (segments: RtcSegment[]): RtcDoc => ({ id: "doc", name: "测试", fps: 30, tracks: [{ id: "main", type: "video", segments }] });

describe("当集分镜按真实片段定位", () => {
	it("依时间轴排序，保留同镜多个片段，未入轨置尾且不改分镜顺序", () => {
		const rows = rtcShotListRows(doc([seg("b", "b", 20), seg("a2", "a", 10), seg("a1", "a", 0)]), "ep", shots);
		expect(rows.map(r => r.segmentId)).toEqual(["a1", "a2", "b", undefined]);
		expect(new Set(rows.map(r => r.key)).size).toBe(4);
		expect(shots.map(s => s.id)).toEqual(["a", "b", "c"]);
	});
	it("严格过滤外集同名ID、音频引用和已删分镜", () => {
		const d = doc([seg("foreign", "a", 0, "other"), seg("deleted", "gone")]);
		d.tracks.push({ id: "sound", type: "audio", segments: [seg("sound-a", "a")] });
		expect(rtcShotListRows(d, "ep", shots).every(r => !r.segmentId)).toBe(true);
	});
	it("同起点按轨道显示顺序，上层先于主轨", () => {
		const d = doc([seg("main-a", "a")]);
		d.tracks.push({ id: "upper", type: "video", segments: [seg("upper-b", "b")] });
		expect(rtcShotListRows(d, "ep", shots).slice(0, 2).map(r => r.segmentId)).toEqual(["upper-b", "main-a"]);
	});
	it("复合内镜头映射裁剪与倍速，选宿主，排除窗口外镜头", () => {
		const d = doc([{ id: "host", kind: "compound", subDocId: "sub", targetStartUs: 100, targetDurationUs: 10, sourceStartUs: 10, sourceDurationUs: 20, speed: 2 }]);
		d.subDocs = { sub: { id: "sub", name: "复合", tracks: [{ id: "child", type: "video", segments: [seg("a", "a", 5), seg("b", "b", 20), seg("c", "c", 30)] }] } };
		const rows = rtcShotListRows(d, "ep", shots);
		expect(rows[0]).toMatchObject({ segmentId: "host", startUs: 100, durationUs: 2.5 });
		expect(rows[1]).toMatchObject({ segmentId: "host", startUs: 105, durationUs: 5 });
		expect(rows[2].segmentId).toBeUndefined();
	});
	it("没有时间轴仍显示本集待入轨分镜", () => {
		expect(rtcShotListRows(null, "ep", shots)).toHaveLength(3);
	});
});
