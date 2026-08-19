/**
 * PopoutView —— 弹出窗口里渲染的内容：只显示对应的助手（占满整个独立窗口）。
 * App 在检测到 `?popout=<which>` 时返回本组件（复用 App 的启动流程，不渲染主界面）。
 */
import { useState } from "react";
import { getPopoutWhich } from "./popout";
import JianyiWindow from "@/components/JianyiWindow";
import AssetAssistant from "@/components/AssetAssistant";
import Lightbox from "@/components/Lightbox";
import { useJianyiStore } from "@/store/jianyiAssistantStore";

/** 简一助手弹出：渲染单个对话窗口（占满整窗），会话取最近活跃或新建。 */
function JianyiPopout() {
	const [sid] = useState(() => {
		const sessions = useJianyiStore.getState().sessions;
		if (sessions.length) return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)[0].id;
		return useJianyiStore.getState().newSession();
	});
	return <JianyiWindow popout initialSessionId={sid} initX={0} initY={0} onClose={() => {}} onClone={() => {}} />;
}

export function PopoutView() {
	const which = getPopoutWhich();
	return (
		<>
			{which === "jianyi" && <JianyiPopout />}
			{which === "asset" && <AssetAssistant popout />}
			<Lightbox />
		</>
	);
}
