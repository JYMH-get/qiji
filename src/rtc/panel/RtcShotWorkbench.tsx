import { useDualModeFeature } from '@/store/connectionStore';
/**
 * RtcShotWorkbench —— 设置弹窗中的项目生成设置；可选附当前分镜的生效覆盖摘要。
 * 原文/提示词/垫图/动作/历史 区块已整体移入中栏「AI 工作台」（RtcShotAiWorkbench，共享件见
 * shotWorkbenchParts）；本视图提供项目级生成选项：
 *   - 头部分镜身份 + 引导（提示词与垫图在中栏编辑）；
 *   - 生图要求：ModelPicker cap="image"（家族→线路→模型三级）+ 比例/分辨率/画质；
 *   - 生视频要求：ModelPicker cap="video" + 方法（模型声明多方法才显示）+ 时长/分辨率/比例 + 附带项；
 *   - 图视同源开关；
 *   - 在途任务 chips（中栏也有，这里留一份便于扫状态）。
 *
 * 档位值域一把尺（勿自造）：全部读写 projectStore.mediaSettings（setMediaSettings——与表格模式
 * Frame161195「视频设置」同一份**项目级**设置，两处改动互通）；图像比例/画质=genParams 的
 * IMAGE_ASPECTS / IMAGE_QUALITIES、出图请求=比例+分辨率+质量，
 * 分辨率与视频三档/方法=**[modelOptions](@/lib/modelOptions) 按模型 key 取**——⚠ 第251轮改点：
 * 原来的 `catalog.models.find(...)` 只认 catalog，选中 ComfyUI 直连/LibTV/即梦 这类本地渠道模型时
 * 档位会掉回内置三档（480p/720p/1080p），显示与提交都错；modelOptions 会回退到适配器 paramsSchema。
 * 显示与提交均保留显式设置，目录只提供选项与缺省值。
 * 不做 Frame161195 那个「换模型后回写收敛」effect（它已在表格页承担，双处回写徒增竞态面）。
 */
import { useMemo } from "react";
import { useProjectStore } from "@/store/projectStore";
import { useCatalogStore } from "@/store/catalogStore";
import ModelPicker, { useCapModelOptions, useEffectiveModelKey } from "@/components/ModelPicker";
import { buildImageParams, IMAGE_ASPECTS, IMAGE_QUALITIES } from "@/lib/genParams";
import { METHOD_LABELS, ASPECT_LABELS } from "@/lib/videoMethods";
import { imageResolutionOptionsForKey, modelMethodsForKey, videoReqOptionsForKey } from "@/lib/modelOptions";
import type { MediaSettings } from "@/services/projectFile";
import { JobChips, secTitle, secBox } from "./shotWorkbenchParts";
import { useShotPreparing, withCurrentOption } from "./rtcShotSubmission";

/* 单行样式：标题左 + 控件右（与 Frame161195 视频设置面板同观感，收窄适配 360px 右栏） */
const rowSt: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, fontSize: 11, color: "rgba(255,255,255,0.6)" };
const rowLb: React.CSSProperties = { whiteSpace: "nowrap", flexShrink: 0 };
const rowCtl: React.CSSProperties = { flex: 1, minWidth: 0, maxWidth: 170, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 6, color: "#fff", padding: "5px 8px", fontSize: 12, outline: "none", cursor: "pointer" };
const rowPicker: React.CSSProperties = { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 };
const optBg: React.CSSProperties = { background: "#1f1f2e" };
const groupHead: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: "#fff" };
const divider: React.CSSProperties = { height: 1, background: "rgba(255,255,255,0.08)" };

const QUALITY_LABEL: Record<string, string> = { low: "低", medium: "中", high: "高", auto: "自动" };

export function RtcShotWorkbench({ episodeId = "", shotId = "" }: { episodeId?: string; shotId?: string }) {
	const owner = useProjectStore(s => s.projectInstanceId);
	const shot = useProjectStore((s) => s.episodes.find((e) => e.id === episodeId)?.shots.find((x) => x.id === shotId));
	const epTitle = useProjectStore((s) => s.episodes.find((e) => e.id === episodeId)?.title) || "";
	const ms = useProjectStore((s) => s.mediaSettings);
	const setMS = (patch: Partial<MediaSettings>) => {
		const state = useProjectStore.getState();
		if (state.projectInstanceId === owner && !state.isProjectLoading) state.setMediaSettings(patch);
	};

	// 生图档位：目录提供选项与缺省值，保留当前显式选择
	// （catalog 优先、ComfyUI/LibTV/即梦 等本地渠道回退适配器 paramsSchema），与提交层 shotGenActions 同尺
	const catalogVer = useCatalogStore((s) => s.catalog?.version);
	const sbImgModelKey = useEffectiveModelKey("image");
	const sbResOptions = useMemo(() => imageResolutionOptionsForKey(sbImgModelKey), [sbImgModelKey, catalogVer]);
	const imageAspect = ms.imageAspect ?? "16:9";
	const imageResolution = ms.imageResolution ?? String(buildImageParams({}, sbResOptions).resolution);
	const imageQuality = ms.imageQuality ?? "high";

	// 生视频档位：方法/时长/分辨率/比例按当前生效视频模型 catalog 下发（本地 CLI 模型=内置回退档）
	const vidModelKey = useEffectiveModelKey("video");
	const videoOptions = useCapModelOptions("video");
	const vidMethods = useMemo(() => modelMethodsForKey(vidModelKey), [vidModelKey, catalogVer]);
	const vidMethod = ms.videoMethod ?? vidMethods[0];
	const vidReq = useMemo(() => videoReqOptionsForKey(vidModelKey), [vidModelKey, catalogVer]);
	const maxDuration = ms.maxDuration ?? vidReq.durations[0] ?? 15;
	const resolution = ms.resolution ?? vidReq.resolutions[0] ?? "720p";
	const aspect = ms.aspect ?? vidReq.aspects[0] ?? "16:9";
	const ov = shot?.overrides;
	const hasVideoOverride = !!ov && [ov.videoModelKey, ov.duration, ov.resolution, ov.aspect, ov.method].some(v => v !== undefined);
	const shotModelKey = ov?.videoModelKey || vidModelKey;
	const shotReq = useMemo(() => videoReqOptionsForKey(shotModelKey), [shotModelKey, catalogVer]);
	const shotModelLabel = videoOptions.find(o => o.id === shotModelKey)?.label || shotModelKey || "未选择模型";
	const shotVideoSummary = [shotModelLabel, `${ov?.duration ?? shot?.durationSec ?? ms.maxDuration ?? shotReq.durations[0] ?? 15}s`, ov?.resolution ?? ms.resolution ?? shotReq.resolutions[0] ?? "720p", ov?.aspect ?? ms.aspect ?? shotReq.aspects[0] ?? "16:9", ov?.method ? METHOD_LABELS[ov.method as keyof typeof METHOD_LABELS] || ov.method : null].filter(Boolean).join(" · ");
	const preparingImage = useShotPreparing(episodeId, shotId, "storyboard");
	const preparingVideo = useShotPreparing(episodeId, shotId, "video");
	const dualModeEnabled = useDualModeFeature();
	const sameSource = !dualModeEnabled || (ms.imgVideoSameSource ?? false);

	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 14, padding: "12px 12px 24px" }}>
			{/* 头部：分镜身份 + 中栏编辑引导 */}
			{shot && <div style={secBox}>
				<div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
					<span style={{ fontSize: 13, fontWeight: 600, color: "#fff" }}>{shot.title || "分镜"}</span>
					<span style={{ fontSize: 10, color: "rgba(255,255,255,0.4)" }}>{epTitle}{shot.durationSec ? ` · ${shot.durationSec}s` : ""}</span>
				</div>
				<div style={{ fontSize: 10.5, color: "rgba(255,255,255,0.38)", lineHeight: 1.6 }}>
					本分镜覆盖在「AI 工作台」调整，下面设置项目默认值。
				</div>
			</div>}

			{/* 生图要求 */}
			<div style={secBox}>
				<div style={groupHead}>生图要求（故事板）</div>
				<ModelPicker cap="image" label="生图模型" style={rowPicker} />
				<label style={rowSt}>
					<span style={rowLb}>图像比例</span>
					<select value={imageAspect} onChange={(e) => setMS({ imageAspect: e.target.value })} style={rowCtl}>
						{withCurrentOption(IMAGE_ASPECTS.map(a => a.v), imageAspect).map((value) => (
							<option key={value} value={value} style={optBg}>{ASPECT_LABELS[value] || IMAGE_ASPECTS.find(a => a.v === value)?.label || value}</option>
						))}
					</select>
				</label>
				<label style={rowSt}>
					<span style={rowLb}>分辨率</span>
					<select value={imageResolution} onChange={(e) => setMS({ imageResolution: e.target.value })} style={rowCtl}>
						{withCurrentOption(sbResOptions.map(r => r.v), imageResolution).map((v) => <option key={v} value={v} style={optBg}>{sbResOptions.find(r => r.v === v)?.label || v}</option>)}
					</select>
				</label>
				<label style={rowSt}>
					<span style={rowLb}>画质 <span style={{ color: "rgba(255,255,255,0.35)" }}>（{imageAspect} · {imageResolution}）</span></span>
					<select value={imageQuality} onChange={(e) => setMS({ imageQuality: e.target.value })} style={rowCtl}>
						{withCurrentOption(IMAGE_QUALITIES, imageQuality).map((v) => <option key={v} value={v} style={optBg}>{QUALITY_LABEL[v] || v}</option>)}
					</select>
				</label>
			</div>

			<div style={divider} />

			{/* 生视频要求 */}
			<div style={secBox}>
				<div style={groupHead}>生视频项目默认</div>
				{hasVideoOverride && <div title={shotVideoSummary} style={{ fontSize: 10.5, lineHeight: 1.5, color: "#c4b5fd", overflowWrap: "anywhere" }}>本镜生效：{shotVideoSummary}</div>}
				<ModelPicker cap="video" label="生视频模型" style={rowPicker} />
				{withCurrentOption<string>(vidMethods, vidMethod).length > 1 && (
					<label style={rowSt}>
						<span style={rowLb} title="首尾帧=首帧（故事板图或素材第1张图）+ 尾帧（素材下一张图）">方法</span>
						<select value={vidMethod} onChange={(e) => setMS({ videoMethod: e.target.value })} style={rowCtl}>
							{withCurrentOption<string>(vidMethods, vidMethod).map((k) => <option key={k} value={k} style={optBg}>{METHOD_LABELS[k as keyof typeof METHOD_LABELS] || k}</option>)}
						</select>
					</label>
				)}
				<label style={rowSt}>
					<span style={rowLb}>时长(秒)</span>
					<select value={maxDuration} onChange={(e) => setMS({ maxDuration: Number(e.target.value) })} style={rowCtl}>
						{withCurrentOption(vidReq.durations, maxDuration).map((d) => <option key={d} value={d} style={optBg}>{d} 秒</option>)}
					</select>
				</label>
				<label style={rowSt}>
					<span style={rowLb}>分辨率</span>
					<select value={resolution} onChange={(e) => setMS({ resolution: e.target.value })} style={rowCtl}>
						{withCurrentOption(vidReq.resolutions, resolution).map((r) => <option key={r} value={r} style={optBg}>{r}</option>)}
					</select>
				</label>
				<label style={rowSt}>
					<span style={rowLb}>比例</span>
					<select value={aspect} onChange={(e) => setMS({ aspect: e.target.value })} style={rowCtl}>
						{withCurrentOption(vidReq.aspects, aspect).map((a) => <option key={a} value={a} style={optBg}>{ASPECT_LABELS[a] || a}</option>)}
					</select>
				</label>
				<div style={rowSt}>
					<span style={rowLb}>生成时附带</span>
					<span style={{ display: "flex", gap: 12, fontSize: 12, color: "#fff" }}>
						<label style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer" }}>
							<input type="checkbox" checked={ms.genWithAsset ?? true} onChange={(e) => setMS({ genWithAsset: e.target.checked })} />带资产
						</label>
						<label style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer" }}>
							<input type="checkbox" checked={ms.genWithStory ?? false} onChange={(e) => setMS({ genWithStory: e.target.checked })} />带故事板
						</label>
					</span>
				</div>
			</div>

			<div style={divider} />

			{/* 图视同源开关 */}
			<div style={secBox}>
				<label style={{ ...rowSt, cursor: "pointer" }} title="开启后：故事板与视频共用同一段「同源提示词」，中栏提示词区只有单栏；推理走同源模板。">
					<span style={rowLb}>图视同源</span>
					<span style={{ display: "flex", alignItems: "center", gap: 6, color: "#fff", fontSize: 12 }}>
						<input type="checkbox" checked={sameSource} disabled={!dualModeEnabled} onChange={(e) => setMS({ imgVideoSameSource: e.target.checked })} />图片与视频共用提示词
					</span>
				</label>
				<div style={{ fontSize: 10, color: "rgba(255,255,255,0.32)", lineHeight: 1.6 }}>
					以上为项目级生成偏好——与表格模式「视频设置」同一份，任一处改动两边同步生效。
				</div>
			</div>

			{/* 在途任务 chips（生成操作在中栏；这里留状态一览） */}
			{shot && <div style={secBox}>
				<div style={{ ...secTitle, fontSize: 10 }}><span>在途任务</span></div>
				{preparingImage && <span style={secTitle}>故事板素材准备中…</span>}
				<JobChips shotId={shotId} field="storyboard" />
				{preparingVideo && <span style={secTitle}>视频素材准备中…</span>}
				<JobChips shotId={shotId} field="video" />
			</div>}
		</div>
	);
}
