import { describe, it, expect } from "vitest";
import { adaptParamsToSchema, type ParamFieldLike } from "@/lib/modelParamAdapt";

const RES = (options: string[], def = options[0]): ParamFieldLike =>
	({ key: "resolution", type: "enum", options, default: def });
const DUR_ENUM = (options: string[]): ParamFieldLike => ({ key: "duration", type: "enum", options, default: options[0] });
const DUR_NUM = (min: number, max: number): ParamFieldLike => ({ key: "duration", type: "number", min, max, default: max });

describe("adaptParamsToSchema", () => {
	it("值在档内 → 不动（勿把用户选择重置成默认）", () => {
		expect(adaptParamsToSchema([RES(["720p", "1080p"])], { resolution: "1080p" })).toEqual({});
	});

	it("越档枚举 → 取 default（default 在档内），否则首档", () => {
		expect(adaptParamsToSchema([RES(["720p"], "720p")], { resolution: "1080p" })).toEqual({ resolution: "720p" });
		// default 也不在档内 → 首档
		expect(adaptParamsToSchema([RES(["480p", "720p"], "4k")], { resolution: "1080p" })).toEqual({ resolution: "480p" });
	});

	it("数字枚举（时长档）→ 就近取档、并列取小，且保持原值类型", () => {
		expect(adaptParamsToSchema([DUR_ENUM(["5", "10", "15"])], { duration: 15 })).toEqual({}); // 数字 15 命中字符串档 "15"
		expect(adaptParamsToSchema([DUR_ENUM(["5", "10"])], { duration: 15 })).toEqual({ duration: 10 });
		expect(adaptParamsToSchema([DUR_ENUM(["5", "10"])], { duration: 7.5 })).toEqual({ duration: 5 }); // 并列取小
		expect(adaptParamsToSchema([DUR_ENUM(["5", "10"])], { duration: "15" })).toEqual({ duration: "10" });
	});

	it("number 型 → 夹到 [min,max]，范围内不动", () => {
		expect(adaptParamsToSchema([DUR_NUM(4, 10)], { duration: 15 })).toEqual({ duration: 10 });
		expect(adaptParamsToSchema([DUR_NUM(4, 15)], { duration: 15 })).toEqual({});
		expect(adaptParamsToSchema([DUR_NUM(4, 15)], { duration: 2 })).toEqual({ duration: 4 });
	});

	it("未设置的键不写（运行时按 default 走，勿凭空落值）", () => {
		expect(adaptParamsToSchema([RES(["720p"]), DUR_NUM(4, 10)], {})).toEqual({});
		expect(adaptParamsToSchema([RES(["720p"])], { resolution: undefined })).toEqual({});
	});

	it("新模型未声明的键不动（提交层各自兜底，勿在此丢用户设置）", () => {
		expect(adaptParamsToSchema([RES(["720p"])], { aspect_ratio: "21:9", resolution: "720p" })).toEqual({});
	});

	it("空表 / 空参数 → 空补丁", () => {
		expect(adaptParamsToSchema(undefined, { resolution: "1080p" })).toEqual({});
		expect(adaptParamsToSchema([RES(["720p"])], undefined)).toEqual({});
	});
});
