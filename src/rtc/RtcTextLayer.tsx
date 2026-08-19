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
 *   - `pointerEvents: none`——字幕层绝不吃播放器/选中框的事件；z 序由挂载方给
 *     （在全部视频图层之上、占位提示卡之下）。
 */
import { useMemo } from "react";
import type { RtcDoc } from "@/types/rtc";
import { activeTextSegments, textStyleOf } from "@/lib/rtcTextCore";
import { activeScriptLaneTexts, scriptLaneItems } from "@/lib/rtcScriptLane";
import { useRtcStore } from "@/store/rtcStore";
import { useProjectStore, resolveEpisodeKey } from "@/store/projectStore";

export function RtcTextLayer({ doc, tUs }: { doc: RtcDoc; tUs: number }) {
	const active = activeTextSegments(doc, tUs);
	/* 原文参考条（用户定稿：原文显示在预览窗，O/工具条开关控制的就是它的显隐）：
	 * 内容**实时派生自主轨分镜**（rtcScriptLane，非轨道数据）——分镜原文改了立即变、
	 * 主轨片段挪动/分割即时跟随；顶部半透明底小字样式与成片字幕明确区分，恒不导出。 */
	const scriptVisible = useRtcStore((s) => s.scriptTrackVisible);
	const epKey = useProjectStore((s) => resolveEpisodeKey(s.rtcEpisodeId, s.episodes));
	const episode = useProjectStore((s) => s.episodes.find((e) => e.id === epKey));
	const lane = useMemo(() => scriptLaneItems(doc, episode), [doc, episode]);
	const scripts = scriptVisible ? activeScriptLaneTexts(lane, tUs) : [];
	if (active.length === 0 && scripts.length === 0) return null;
	return (
		<div style={{ position: "absolute", inset: 0, zIndex: 45, pointerEvents: "none", containerType: "size", overflow: "hidden" }}>
			{scripts.length > 0 && (
				<div style={{ position: "absolute", left: "50%", top: "4%", transform: "translateX(-50%)", maxWidth: "88%", display: "flex", flexDirection: "column", gap: 4, alignItems: "center" }}>
					{scripts.map((item) => (
						<div
							key={item.key}
							style={{
								padding: "0.35em 0.8em",
								borderRadius: 6,
								background: "rgba(10,12,18,0.62)",
								border: "1px solid rgba(255,255,255,0.10)",
								color: "rgba(255,255,255,0.88)",
								fontSize: "3cqh",
								lineHeight: 1.45,
								textAlign: "left",
								whiteSpace: "pre-wrap",
								wordBreak: "break-word",
								display: "-webkit-box",
								WebkitBoxOrient: "vertical",
								WebkitLineClamp: 3, // 长原文截 3 行（完整内容在时间轴片段/右栏看）
								overflow: "hidden",
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
