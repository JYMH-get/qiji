/**
 * RtcTextLayer —— 预览画幅框内的字幕渲染层（第三批）。
 *
 * 渲染播放头处全部活动字幕片段（rtcTextCore.activeTextSegments，text 轨 kind=media 有内容者）：
 *   - 绝对定位在画幅框内：left/top 按样式 x/y（画幅比例，0=中心）+ translate(-50%,-50%) 居中锚；
 *   - **字号零测量**：本层自身是 `container-type: size` 的查询容器（inset:0 铺满画幅框）→
 *     `font-size = fontSize×100 cqh` 恒等于「画幅高的比例」，不依赖任何 JS 实测（与画幅框
 *     排版同哲学，见 RtcSequencePlayer 头注释「绝不依赖 JS 实测」）；
 *   - 描边用四向 text-shadow 近似（-webkit-text-stroke 会啃细字面；预览观感够用，
 *     导出剪映走真描边 materials.texts.strokes）；
 *   - 字幕不接收指针事件；原文参考区域独立接收滚动，长文可完整阅读。
 *     z 序由挂载方给（在全部视频图层之上）。
 */
import { useMemo } from "react";
import type { RtcDoc } from "@/types/rtc";
import { activeTextSegments, textStyleOf } from "@/lib/rtcTextCore";
import { activeScriptLaneTexts, scriptLaneItems } from "@/lib/rtcScriptLane";
import { useRtcStore } from "@/store/rtcStore";
import { useProjectStore, resolveEpisodeKey } from "@/store/projectStore";

export function RtcTextLayer({ doc, tUs, showScriptReference = true }: { doc: RtcDoc; tUs: number; showScriptReference?: boolean }) {
	const active = activeTextSegments(doc, tUs);
	/* 原文参考条（用户定稿：原文显示在预览窗，快捷键/工具条开关控制的就是它的显隐）：
	 * 内容**实时派生自主轨分镜**（rtcScriptLane，非轨道数据）——分镜原文改了立即变、
	 * 主轨片段挪动/分割即时跟随；顶部半透明底小字样式与成片字幕明确区分，恒不导出。 */
	const scriptVisible = useRtcStore((s) => s.scriptTrackVisible);
	const epKey = useProjectStore((s) => resolveEpisodeKey(s.rtcEpisodeId, s.episodes));
	const episode = useProjectStore((s) => s.episodes.find((e) => e.id === epKey));
	const lane = useMemo(() => scriptLaneItems(doc, episode), [doc, episode]);
	// 工作台已有原文对照，临时隐藏浮层，不改用户的快捷键/工具条开关偏好。
	const scripts = scriptVisible && showScriptReference ? activeScriptLaneTexts(lane, tUs) : [];
	if (active.length === 0 && scripts.length === 0) return null;
	return (
		<div style={{ position: "absolute", inset: 0, zIndex: 45, pointerEvents: "none", containerType: "size", overflow: "hidden" }}>
			{scripts.length > 0 && (
				<div
					key={scripts.map((item) => item.key).join("|")}
					role="region"
					aria-label="原文参考"
					tabIndex={0}
					onPointerDown={(e) => e.stopPropagation()}
					onWheel={(e) => e.stopPropagation()}
					onKeyDown={(e) => {
						if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(e.key)) e.stopPropagation();
					}}
					style={{ position: "absolute", left: "6%", right: "6%", top: "3%", maxHeight: "36%", overflowY: "auto", overscrollBehavior: "contain", pointerEvents: "auto", padding: "0.4em 0.75em", borderRadius: 6, background: "rgba(10,12,18,0.62)", border: "1px solid rgba(255,255,255,0.10)", color: "rgba(255,255,255,0.88)", fontSize: "clamp(10px, 2.4cqh, 14px)", lineHeight: 1.45 }}
				>
					{scripts.map((item) => (
						<div
							key={item.key}
							style={{
								padding: "0.15em 0",
								textAlign: "left",
								whiteSpace: "pre-wrap",
								overflowWrap: "anywhere",
							}}
						>
							{item.text}
						</div>
					))}
				</div>
			)}
			{active.map((seg) => {
				const t = textStyleOf(seg);
				const stroke = t.strokeColor;
				return (
					<div
						key={seg.id}
						style={{
							position: "absolute",
							left: `${(0.5 + t.x) * 100}%`,
							top: `${(0.5 + t.y) * 100}%`,
							transform: "translate(-50%, -50%)",
							maxWidth: "92%",
							fontSize: `${t.fontSize * 100}cqh`,
							lineHeight: 1.3,
							fontWeight: 600,
							color: t.color,
							textAlign: "center",
							whiteSpace: "pre-wrap",
							wordBreak: "break-word",
							// 四向阴影近似描边（偏移随字号走 em，粗细观感稳定）
							textShadow: `0.045em 0.045em 0 ${stroke}, -0.045em 0.045em 0 ${stroke}, 0.045em -0.045em 0 ${stroke}, -0.045em -0.045em 0 ${stroke}`,
						}}
					>
						{t.content}
					</div>
				);
			})}
		</div>
	);
}
