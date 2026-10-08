import { useEffect, useRef, useState } from "react";
import { useProjectStore } from "@/store/projectStore";
import { activeRtcDoc, useRtcStore } from "@/store/rtcStore";
import { resolveAdjacentFrame, type RtcFrameEdge } from "./rtcAdjacentFrames";
import { insertAdjacentFrame, type RtcInsertedFrame } from "./rtcAdjacentFrameCapture";

export function RtcAdjacentFrameButtons({ segId, onInsert, disabled, shouldContinue }: {
	segId: string;
	onInsert: (frame: RtcInsertedFrame, edge: RtcFrameEdge) => void;
	disabled?: boolean;
	shouldContinue?: () => boolean;
}) {
	const doc = useRtcStore(activeRtcDoc);
	const owner = useProjectStore(state => state.projectInstanceId);
	const [busy, setBusy] = useState<RtcFrameEdge | null>(null);
	const [error, setError] = useState("");
	const request = useRef(0);
	useEffect(() => {
		request.current++; setBusy(null); setError("");
		return () => { request.current++; };
	}, [owner, segId]);
	const insert = async (edge: RtcFrameEdge) => {
		if (busy || disabled) return;
		const token = ++request.current;
		setBusy(edge); setError("");
		try {
			await insertAdjacentFrame({ segId, edge, onInsert, shouldContinue: () => request.current === token && shouldContinue?.() !== false });
		} catch (cause) {
			if (request.current === token) setError(cause instanceof Error ? cause.message : "取帧失败");
		} finally { if (request.current === token) setBusy(null); }
	};
	return <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "flex-end", alignItems: "center", gap: 5 }}>
		{(["first", "last"] as const).map(edge => {
			const available = !!doc && !!resolveAdjacentFrame(doc, segId, edge);
			const blocked = !!disabled || !!busy || !available;
			return <button key={edge} type="button" disabled={blocked} onClick={() => void insert(edge)}
				title={edge === "first" ? "取上一个可见素材的裁剪尾帧" : "取下一个可见素材的裁剪首帧"}
				style={{ padding: "5px 8px", borderRadius: 6, fontSize: 11, border: "1px solid rgba(255,255,255,0.18)",
					background: "rgba(255,255,255,0.04)", color: "rgba(255,255,255,0.85)", opacity: blocked ? 0.45 : 1, cursor: blocked ? "default" : "pointer" }}>
				{busy === edge ? "取帧中…" : edge === "first" ? "插入首帧" : "插入尾帧"}
			</button>;
		})}
		{error && <span role="status" title={error} style={{ width: "100%", fontSize: 10, color: "#fca5a5", textAlign: "right" }}>{error}</span>}
	</div>;
}
