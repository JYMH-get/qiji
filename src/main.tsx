import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { getPopoutWhich } from "./popout/popout";
import "./styles.css";

// 弹出窗口标记：projectStore.save 据此跳过写盘（弹出窗口为只读视图，避免与主窗口互相覆盖）。
const _popout = getPopoutWhich();
if (_popout) (window as unknown as { __QIJI_POPOUT__?: string }).__QIJI_POPOUT__ = _popout;

ReactDOM.createRoot(document.getElementById("root")!).render(
	<React.StrictMode>
		<App />
	</React.StrictMode>,
);
