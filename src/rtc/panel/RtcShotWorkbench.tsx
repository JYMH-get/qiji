/**
 * RtcShotWorkbench —— 右栏「分镜占位符」属性视图（中栏双页签改版后收敛为 **AI 生成属性**）。
 * 原文/提示词/垫图/动作/历史 区块已整体移入中栏「AI 工作台」（RtcShotAiWorkbench，共享件见
 * shotWorkbenchParts）；本视图只留 AI 生成的**可选项属性**（用户定稿「占位时的属性仅作为
 * AI 生成属性选择，比如生图时的渠道、模型、比例、画质等」）：
 *   - 头部分镜身份 + 引导（提示词与垫图在中栏编辑）；
 *   - 生图要求：ModelPicker cap="image"（家族→线路→模型三级）+ 比例/分辨率/画质；
 *   - 生视频要求：ModelPicker cap="video" + 方法（模型声明多方法才显示）+ 时长/分辨率/比例 + 附带项；
 *   - 图视同源开关；
 *   - 在途任务 chips（中栏也有，这里留一份便于扫状态）。
 *
 * 档位值域一把尺（勿自造）：全部读写 projectStore.mediaSettings（setMediaSettings——与表格模式
 * Frame161195「视频设置」同一份**项目级**设置，两处改动互通）；图像比例/画质=genParams 的
 * IMAGE_ASPECTS / IMAGE_QUALITIES、出图 size=resolveSize（全客户端唯一一份 SIZE_MAP）、
 * 分辨率与视频三档/方法=**[modelOptions](@/lib/modelOptions) 按模型 key 取**——⚠ 第251轮改点：
 * 原来的 `catalog.models.find(...)` 只认 catalog，选中 ComfyUI 直连/LibTV/即梦 这类本地渠道模型时
 * 档位会掉回内置三档（480p/720p/1080p），显示与提交都错；modelOptions 会回退到适配器 paramsSchema。
 * 显示层 clamp 与提交层（shotGenActions）用的是同一组函数。
 * 不做 Frame161195 那个「换模型后回写收敛」effect（它已在表格页承担，双处回写徒增竞态面）。
 */
import { useMemo } from "react";
import { useProjectStore } from "@/store/projectStore";
import { useCatalogStore } from "@/store/catalogStore";
import ModelPicker, { useEffectiveModelKey } from "@/components/ModelPicker";
import { clampDuration, clampImageResolution, resolveSize, IMAGE_ASPECTS, IMAGE_QUALITIES } from "@/lib/genParams";
import { METHOD_LABELS, ASPECT_LABELS, clampMethod, clampToOptions, clampDurationTo } from "@/lib/videoMethods";
import { imageResolutionOptionsForKey, modelMethodsForKey, videoReqOptionsForKey } from "@/lib/modelOptions";
import type { MediaSettings } from "@/services/projectFile";
import { JobChips, secTitle, secBox } from "./shotWorkbenchParts";

/* 单行样式：标题左 + 控件右（与 Frame161195 视频设置面板同观感，收窄适配 360px 右栏） */
const rowSt: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, fontSize: 11, color: "rgba(255,255,255,0.6)" };
const rowLb: React.CSSProperties = { whiteSpace: "nowrap", flexShrink: 0 };
const rowCtl: React.CSSProperties = { flex: 1, minWidth: 0, maxWidth: 170, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 6, color: "#fff", padding: "5px 8px", fontSize: 12, outline: "none", cursor: "pointer" };
const rowPicker: React.CSSProperties = { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 };
const optBg: React.CSSProperties = { background: "#1f1f2e" };
const groupHead: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: "#fff" };
const divider: React.CSSProperties = { height: 1, background: "rgba(255,255,255,0.08)" };

const QUALITY_LABEL: Record<string, string> = { low: "低", medium: "中", high: "高", auto: "自动" };

export function RtcShotWorkbench({ episodeId, shotId }: { episodeId: string; shotId: string }) {
	const shot = useProjectStore((s) => s.episodes.find((e) => e.id === episodeId)?.shots.find((x) => x.id === shotId));
	const epTitle = useProjectStore((s) => s.episodes.find((e) => e.id === episodeId)?.title) || "";
	const ms = useProjectStore((s) => s.mediaSettings);
	const setMS = (patch: Partial<MediaSettings>) => useProjectStore.getState().setMediaSettings(patch);

	// 生图档位：分辨率按当前生效图像模型收敛——走 modelOptions 一把尺
	// （catalog 优先、ComfyUI/LibTV/即梦 等本地渠道回退适配器 paramsSchema），与提交层 shotGenActions 同尺
	const catalogVer = useCatalogStore((s) => s.catalog?.version);
	const sbImgModelKey = useEffectiveModelKey("image");
	const sbResOptions = useMemo(() => imageResolutionOptionsForKey(sbImgModelKey), [sbImgModelKey, catalogVer]);
	const imageAspect = ms.imageAspect ?? "16:9";
	const imageResolution = clampImageResolution(ms.imageResolution, sbResOptions);
	const imageQuality = ms.imageQuality ?? "high";
	const imageSize = resolveSize(imageAspect, imageResolution);

	// 生视频档位：方法/时长/分辨率/比例按当前生效视频模型 catalog 下发（本地 CLI 模型=内置回退档）
	const vidModelKey = useEffectiveModelKey("video");
	const vidMethods = useMemo(() => modelMethodsForKey(vidModelKey), [vidModelKey, catalogVer]);
	const vidMethod = clampMethod(ms.videoMethod, vidMethods);
	const vidReq = useMemo(() => videoReqOptionsForKey(vidModelKey), [vidModelKey, catalogVer]);
	const maxDuration = ms.maxDuration ?? 15;
	const sameSource = ms.imgVideoSameSource ?? false;

	if (!shot) {
		return (
			<div style={{ padding: 16, fontSize: 12, color: "rgba(255,255,255,0.5)", lineHeight: 1.8 }}>
				该占位符关联的分镜已被删除。
				<br />可在时间轴上删除此占位符，或回到视频界面重建分镜。
			</div>
		);
	}

	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 14, padding: "12px 12px 24px" }}>
			{/* 头部：分镜身份 + 中栏编辑引导 */}
			<div style={secBox}>
				<div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
					<span style={{ fontSize: 13, fontWeight: 600, color: "#fff" }}>{shot.title || "分镜"}</span>
					<span style={{ fontSize: 10, color: "rgba(255,255,255,0.4)" }}>{epTitle}{shot.durationSec ? ` · ${shot.durationSec}s` : ""} · 占位符</span>
				</div>
				<div style={{ fontSize: 10.5, color: "rgba(255,255,255,0.38)", lineHeight: 1.6 }}>
					提示词、垫图与生成操作在中栏「AI 工作台」页编辑；本页选择生成要求。
				</div>
			</div>

			{/* 生图要求 */}
			<div style={secBox}>
				<div style={groupHead}>生图要求（故事板）</div>
				<ModelPicker cap="image" label="生图模型" style={rowPicker} />
				<label style={rowSt}>
					<span style={rowLb}>图像比例</span>
					<select value={imageAspect} onChange={(e) => setMS({ imageAspect: e.target.value })} style={rowCtl}>
						{IMAGE_ASPECTS.map((a) => (
							<option key={a.v} value={a.v} style={optBg}>{ASPECT_LABELS[a.v] || a.label}</option>
						))}
					</select>
				</label>
				<label style={rowSt}>
					<span style={rowLb}>分辨率</span>
					<select value={imageResolution} onChange={(e) => setMS({ imageResolution: e.target.value })} style={rowCtl}>
						{sbResOptions.map((r) => <option key={r.v} value={r.v} style={optBg}>{r.label}</option>)}
					</select>
				</label>
				<label style={rowSt}>
					<span style={rowLb}>画质 <span style={{ color: "rgba(255,255,255,0.35)" }}>（size {imageSize}）</span></span>
					<select value={imageQuality} onChange={(e) => setMS({ imageQuality: e.target.value })} style={rowCtl}>
						{IMAGE_QUALITIES.map((v) => <option key={v} value={v} style={optBg}>{QUALITY_LABEL[v] || v}</option>)}
					</select>
				</label>
			</div>

			<div style={divider} />

			{/* 生视频要求 */}
			<div style={secBox}>
				<div style={groupHead}>生视频要求</div>
				<ModelPicker cap="video" label="生视频模型" style={rowPicker} />
				{vidMethods.length > 1 && (
					<label style={rowSt}>
						<span style={rowLb} title="首尾帧=首帧（故事板图或素材第1张图）+ 尾帧（素材下一张图）">方法</span>
						<select value={vidMethod} onChange={(e) => setMS({ videoMethod: e.target.value })} style={rowCtl}>
							{vidMethods.map((k) => <option key={k} value={k} style={optBg}>{METHOD_LABELS[k]}</option>)}
						</select>
					</label>
				)}
				<label style={rowSt}>
					<span style={rowLb}>时长(秒)</span>
					<select value={clampDurationTo(clampDuration(maxDuration), vidReq.durations)} onChange={(e) => setMS({ maxDuration: Number(e.target.value) })} style={rowCtl}>
						{vidReq.durations.map((d) => <option key={d} value={d} style={optBg}>{d} 秒</option>)}
					</select>
				</label>
				<label style={rowSt}>
					<span style={rowLb}>分辨率</span>
					<select value={clampToOptions(ms.resolution ?? "720p", vidReq.resolutions)} onChange={(e) => setMS({ resolution: e.target.value })} style={rowCtl}>
						{vidReq.resolutions.map((r) => <option key={r} value={r} style={optBg}>{r}</option>)}
					</select>
				</label>
				<label style={rowSt}>
					<span style={rowLb}>比例</span>
					<select value={clampToOptions(ms.aspect ?? "16:9", vidReq.aspects)} onChange={(e) => setMS({ aspect: e.target.value })} style={rowCtl}>
						{vidReq.aspects.map((a) => <option key={a} value={a} style={optBg}>{ASPECT_LABELS[a] || a}</option>)}
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
						<input type="checkbox" checked={sameSource} onChange={(e) => setMS({ imgVideoSameSource: e.target.checked })} />图片与视频共用提示词
					</span>
				</label>
				<div style={{ fontSize: 10, color: "rgba(255,255,255,0.32)", lineHeight: 1.6 }}>
					以上为项目级生成偏好——与表格模式「视频设置」同一份，任一处改动两边同步生效。
				</div>
			</div>

			{/* 在途任务 chips（生成操作在中栏；这里留状态一览） */}
			<div style={secBox}>
				<div style={{ ...secTitle, fontSize: 10 }}><span>在途任务</span></div>
				<JobChips shotId={shotId} field="storyboard" />
				<JobChips shotId={shotId} field="video" />
			</div>
		</div>
	);
}
