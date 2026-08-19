/**
 * flowActions —— 实时剪辑「AI 生成」分步工作台的动作层。
 *
 * 全部复用既有链路（不另起炉灶）：
 *  - 剧集拆分/资产拆分走 runPurpose("script.analyze")（§9A 唯一路径；提示词正文在服务端，
 *    客户端只发 templateId + variables）——逻辑与 Frame1693 handleSplitEpisodes /
 *    handleExtractAssets / handleContinueExtraction 逐段对齐（owner 防串台、analysisTask
 *    断连保护、流式合并、截断抢救提醒同款）；
 *  - 本地快拆走 @/lib/episodeSplit 四模式（确定性、不调大模型）；
 *  - 资产落库走 mergeApply / mergeExtraction(…, attachSplitPresets)——第174轮预设装饰钩子
 *    （画风前缀/类别前后缀胶囊）在 assetMerge 内挂上，勿绕过；
 *  - 分镜智能推理/智能拆分走 startInfer（inferTasks 持久化，切页/重启可找回）——参数组装
 *    与 Frame161195 handleSmartInfer / handleSplit 同构（模板/模型来源一致）；
 *  - 占位入轨复用 rtcShotPlaceholders.appendEpisodePlaceholders + rtcStore.commit
 *    （红线：rtc 数据变更只经 commit）。
 *
 * UI 差异：Frame1693/161195 用 alert 报结果，这里改为返回 FlowResult 由工作台内联显示
 * （覆盖确认仍走 confirmDialog——Tauri 下 window.confirm 不弹窗直接放行，勿改）。
 */
import { useProjectStore } from "@/store/projectStore";
import { useRtcStore } from "@/store/rtcStore";
import { runPurpose } from "@/services/purposeRunner";
import { trackTask } from "@/services/taskCenter";
import { effectiveModelKey } from "@/components/ModelPicker";
import { confirmDialog } from "@/lib/confirmDialog";
import { EPISODE_SPLIT_MODES, splitEpisodes } from "@/lib/episodeSplit";
import { parseAssetExtraction } from "@/lib/assetExtraction";
import { mergeApply, mergeExtraction, analysisTimeLabel, type ExtractBuckets } from "@/lib/assetMerge";
import { attachSplitPresets } from "@/lib/splitPresetAttach";
import { buildAssetListVars } from "@/lib/assetVars";
import { appendEpisodePlaceholders, type AppendPlaceholdersResult } from "../rtcShotPlaceholders";
import { buildExtractVariables, episodesBrief, splitOverwriteMessage } from "./flowCore";

export interface FlowResult {
	ok: boolean;
	/** 内联显示的结果/错误文案；空串=静默（如用户取消确认、已切走项目） */
	message: string;
}

const NO_MODEL_MSG = "无可用文本模型：请检查「设置 → 管理端」连接与目录拉取后重试。";

/* ════════════════ ③ 断连恢复（analysisTask 保护） ════════════════ */

/**
 * 断连恢复：上次资产拆分若在途（analysisTask 已落盘）且本会话尚未在跟踪 → 凭 taskId 重连服务端取结果。
 * 覆盖「分析中关闭/刷新客户端」的场景（与 Frame1693 挂载时的恢复 useEffect 同构；两处同款守卫
 * ——analysisRunning 已在跟踪即跳过，双入口不会重复挂）。返回清理函数（卸载停止写库）。
 */
export function resumeAnalysisTask(): (() => void) | undefined {
	const at = useProjectStore.getState().analysisTask;
	if (!at) return undefined;
	if (useProjectStore.getState().analysisRunning) return undefined; // 同会话仍在跟踪，无需恢复
	let done = false;
	// 归属校验基准：恢复发起时的项目实例（onUpdate 期间若用户切走了项目，停止写库防串台）
	const owner = useProjectStore.getState().projectInstanceId;
	const s0 = useProjectStore.getState();
	s0.setAnalysisRunning(true);
	s0.setAnalysisProgress(40);
	trackTask({
		taskId: at.taskId,
		adapterKey: at.adapterKey,
		onUpdate: (progress, status, resultUri, _err, _aid, partialText) => {
			if (done) return;
			// 用户已切到别的项目 → 停止跟踪、不写当前项目（原项目返回时会再次自恢复）
			if (useProjectStore.getState().projectInstanceId !== owner) { done = true; return; }
			const s = useProjectStore.getState();
			if (status === "queued" || status === "running") {
				s.setAnalysisProgress(Math.min(95, 40 + Math.round(progress * 0.5)));
				if (partialText && partialText.length > 40) {
					const live = parseAssetExtraction(partialText);
					const t = live.characters.length + live.scenes.length + live.items.length + live.organisms.length + live.crowds.length;
					// 流式：合并保留（不整体替换），已生成的图与 id 不丢
					if (t > 0) mergeApply(owner, { characters: live.characters, scenes: live.scenes, items: live.items, organisms: live.organisms, crowds: live.crowds }, live.visualBible, "解析中…");
				}
				return;
			}
			done = true;
			if (status === "success") {
				const ex = parseAssetExtraction(resultUri || "");
				// 最终结果：合并到**当前最新** store（含恢复期间生成的图），保留旧资产
				mergeApply(owner, { characters: ex.characters, scenes: ex.scenes, items: ex.items, organisms: ex.organisms, crowds: ex.crowds }, ex.visualBible, analysisTimeLabel());
			}
			s.setAnalysisTask(null);
			s.setAnalysisRunning(false);
			s.setAnalysisProgress(status === "success" ? 100 : 0);
			void s.save(true);
		},
	});
	return () => { done = true; };
}

/* ════════════════ ② 剧集拆分 ════════════════ */

/**
 * 剧集拆分：sel 为本地快拆模式（EPISODE_SPLIT_MODES 之一）或 catalog「剧集」类模板 id（LLM 边界法）。
 * 已有拆分成果时 confirmDialog 确认覆盖。与 Frame1693 handleSplitEpisodes 同构。
 */
export async function splitEpisodesFlow(sel: string): Promise<FlowResult> {
	const st0 = useProjectStore.getState();
	const scriptText = st0.scriptText || "";
	if (!scriptText.trim()) return { ok: false, message: "请先在第①步填写剧本文本。" };

	const brief = episodesBrief(st0.episodes);
	if (brief.hasContent) {
		// ⚠ 确认必须走 confirmDialog（Tauri 下 window.confirm 不弹窗直接放行）
		const ok = await confirmDialog(splitOverwriteMessage(brief));
		if (!ok) return { ok: false, message: "" };
	}
	const owner = st0.projectInstanceId;
	try {
		let eps: Array<{ title: string; scriptText: string }>;
		if ((EPISODE_SPLIT_MODES as readonly string[]).includes(sel)) {
			// 本地快拆（确定性，不调大模型）：episodeSplit 四模式
			eps = splitEpisodes(scriptText, sel);
			if (eps.length === 0) {
				if (sel === "n-n" || sel === "n-1") {
					throw new Error(`未在原文找到「主-副」编号标记（如行首 1-1、2-3 或 场1-1、场2-3），无法用 ${sel} 拆分。请确认原文带编号，或改用其它拆分方式。`);
				}
				eps = [{ title: "第1集", scriptText: scriptText.trim() }];
			}
		} else {
			// LLM 模板分集（按所选 catalog 模板提交，输出按「第N集」标题正文）
			const run = await runPurpose("script.analyze", {
				templateId: sel,
				variables: { 原文: scriptText },
				modelKey: effectiveModelKey("text") || undefined,
				params: { temperature: 0.3, maxTokens: 8192 },
			});
			if (run.status === "no_model") throw new Error(NO_MODEL_MSG);
			if (run.status === "failed") throw new Error(run.error || "剧集拆分失败");
			eps = splitEpisodes(run.resultUri || "", "按第N集");
			if (eps.length === 0) eps = [{ title: "第1集", scriptText: (run.resultUri || scriptText).trim() }];
		}

		// 已切到别的项目 → 放弃写 episodes，避免串台
		if (useProjectStore.getState().projectInstanceId !== owner) return { ok: false, message: "" };
		const baseTs = Date.now();
		useProjectStore.getState().setEpisodes(
			eps.map((e, i) => ({
				id: `ep-${baseTs}-${i}`,
				index: i + 1,
				title: `${String(i + 1).padStart(3, "0")}-${e.title || `第${i + 1}集`}`,
				scriptText: e.scriptText,
				shots: [],
			})),
		);
		await useProjectStore.getState().save(true);
		return { ok: true, message: `✅ 已拆分为 ${eps.length} 集——到第④步逐集推理分镜。` };
	} catch (err) {
		console.error("Split episodes failed:", err);
		return { ok: false, message: `剧集拆分失败：${err instanceof Error ? err.message : "未知错误"}` };
	}
}

/* ════════════════ ③ 资产拆分 ════════════════ */

/**
 * 资产拆分全链（与 Frame1693 handleExtractAssets 同构）：
 * runPurpose("script.analyze") 流式解析 → mergeApply 合并落库（内挂 attachSplitPresets 预设胶囊）；
 * onTaskId 落盘 analysisTask（断连保护）；截断时返回抢救提醒文案。
 */
export async function extractAssetsFlow(templateId: string): Promise<FlowResult> {
	const st0 = useProjectStore.getState();
	const scriptText = st0.scriptText || "";
	if (!scriptText.trim()) return { ok: false, message: "请先在第①步填写剧本文本。" };
	if (!templateId) return { ok: false, message: "请先选择资产拆分模板（需先在管理端配置并连接）。" };
	st0.setAnalysisRunning(true);
	st0.setAnalysisProgress(10);
	// 归属校验基准：本次分析归属于发起时的项目。回调/完成时若已切走，放弃落库防串台。
	const owner = st0.projectInstanceId;
	try {
		useProjectStore.getState().setAnalysisProgress(30);
		const variables = buildExtractVariables({
			scriptText,
			visualStyle: st0.visualStyle || "国漫电影感",
			characters: st0.characters || [], scenes: st0.scenes || [], items: st0.items || [],
			organisms: st0.organisms || [], crowds: st0.crowds || [],
		});
		useProjectStore.getState().setAnalysisProgress(50);

		const run = await runPurpose("script.analyze", {
			templateId,
			variables,
			modelKey: effectiveModelKey("text") || undefined,
			// 整段出图模板下输出极长：65535 + parseAssetExtraction 截断兜底（与 Frame1693 同值）
			params: { temperature: 0.7, maxTokens: 65535 },
			// 落盘在途任务：关客户端后重开可凭 taskId 重连服务端取结果（见 useAnalysisTaskResume）
			onTaskId: (taskId, adapterKey) => {
				if (useProjectStore.getState().projectInstanceId !== owner) return;
				useProjectStore.getState().setAnalysisTask({ taskId, adapterKey, kind: "analyze", startedAt: Date.now() });
			},
			onProgress: (progress, status, partialText) => {
				if (useProjectStore.getState().projectInstanceId !== owner) return; // 已切项目，丢弃流式回调防串台
				if (status === "running" || status === "queued") {
					useProjectStore.getState().setAnalysisProgress(Math.min(95, 50 + Math.round(progress * 0.4)));
				}
				// 流式：合并保留刷入 store（提取一个并入一个；已生成的图与 id 不丢，见 mergeApply）
				if (partialText && partialText.length > 40) {
					const live = parseAssetExtraction(partialText);
					const liveTotal = live.characters.length + live.scenes.length + live.items.length + live.organisms.length + live.crowds.length;
					if (liveTotal > 0) {
						mergeApply(owner, { characters: live.characters, scenes: live.scenes, items: live.items, organisms: live.organisms, crowds: live.crowds }, live.visualBible, "解析中…");
					} else if (live.visualBible.style || live.visualBible.colorSystem || live.visualBible.negativeGlobal) {
						useProjectStore.getState().setVisualBible(live.visualBible);
					}
				}
			},
		});

		// 用户已切到别的项目：放弃落库（原项目 analysisTask 已落盘，返回时断连恢复会重连取结果）
		if (useProjectStore.getState().projectInstanceId !== owner) return { ok: false, message: "" };
		useProjectStore.getState().setAnalysisTask(null); // 任务已终态，清在途记录

		if (run.status === "no_model") throw new Error(NO_MODEL_MSG);
		if (run.status === "failed") throw new Error(run.error || "LLM 提取失败");
		const resultText = run.resultUri || "";
		useProjectStore.getState().setAnalysisProgress(85);
		if (!resultText.trim()) throw new Error("模型返回为空，未提取到任何资产。");

		const extracted = parseAssetExtraction(resultText);
		const total = extracted.characters.length + extracted.scenes.length + extracted.items.length + extracted.organisms.length + extracted.crowds.length;
		if (total === 0) {
			throw new Error("已拿到模型返回，但未能从中解析出资产 JSON（asset.extract.v1）。请检查提示词是否要求输出该结构，或换用支持结构化输出的模型。");
		}

		// 合并到当前最新 store（保留旧资产/已生成图/稳定 id）；attachSplitPresets 在 mergeApply 内挂胶囊
		mergeApply(owner, {
			characters: extracted.characters, scenes: extracted.scenes, items: extracted.items,
			organisms: extracted.organisms, crowds: extracted.crowds,
		}, extracted.visualBible, analysisTimeLabel());

		await useProjectStore.getState().save(true);
		useProjectStore.getState().setAnalysisProgress(100);
		setTimeout(() => { useProjectStore.getState().setAnalysisRunning(false); }, 300);

		if (extracted.truncated) {
			return {
				ok: true,
				message:
					`⚠ 模型输出过长被截断，仅抢救出 ${total} 个资产` +
					(extracted.lastLabel ? `（约提取到「${extracted.lastLabel}」处）` : "") +
					`。其后的资产可能未提取——点「继续提取」补全剩余、不重复、不覆盖已有；可反复点击直到提示"无新增"。`,
			};
		}
		return { ok: true, message: `✅ 提取完成：本轮解析出 ${total} 个资产（已合并落库，左侧资产面板可查看）。` };
	} catch (err) {
		console.error("Script analysis failed:", err);
		if (useProjectStore.getState().projectInstanceId === owner) {
			useProjectStore.getState().setAnalysisRunning(false);
			useProjectStore.getState().setAnalysisProgress(0);
		}
		return { ok: false, message: `剧本分析失败：${err instanceof Error ? err.message : "未知错误"}` };
	}
}

/**
 * 继续提取（分批续提，补全剩余资产）：把已有资产作查重清单喂回模型，只产新增。
 * 与 Frame1693 handleContinueExtraction 同构（合并基准=最新 store，mergeExtraction 带 attachSplitPresets）。
 */
export async function continueExtractionFlow(templateId: string): Promise<FlowResult> {
	const st0 = useProjectStore.getState();
	if (!st0.isAnalyzed) return { ok: false, message: "请先「开始拆分」得到首批资产，再继续提取。" };
	if (!(st0.scriptText || "").trim()) return { ok: false, message: "剧本文本为空。" };
	if (!templateId) return { ok: false, message: "请先选择资产拆分模板。" };
	st0.setAnalysisRunning(true);
	st0.setAnalysisProgress(20);
	const owner = st0.projectInstanceId;
	try {
		const st = useProjectStore.getState();
		const variables = buildExtractVariables({
			scriptText: st.scriptText || "",
			visualStyle: st.visualStyle || "国漫电影感",
			characters: st.characters || [], scenes: st.scenes || [], items: st.items || [],
			organisms: st.organisms || [], crowds: st.crowds || [],
			continueMode: true, // 角色列表并入群像（查重清单，与 Frame1693 同构）
		});
		useProjectStore.getState().setAnalysisProgress(40);
		const run = await runPurpose("script.analyze", {
			templateId,
			variables,
			modelKey: effectiveModelKey("text") || undefined,
			params: { temperature: 0.7, maxTokens: 65535 },
			onTaskId: (taskId, adapterKey) => {
				if (useProjectStore.getState().projectInstanceId !== owner) return;
				useProjectStore.getState().setAnalysisTask({ taskId, adapterKey, kind: "continue", startedAt: Date.now() });
			},
			onProgress: (progress, status) => {
				if (useProjectStore.getState().projectInstanceId !== owner) return;
				if (status === "running" || status === "queued") {
					useProjectStore.getState().setAnalysisProgress(Math.min(95, 40 + Math.round(progress * 0.5)));
				}
			},
		});
		if (useProjectStore.getState().projectInstanceId !== owner) return { ok: false, message: "" };
		useProjectStore.getState().setAnalysisTask(null);
		if (run.status === "no_model") throw new Error(NO_MODEL_MSG);
		if (run.status === "failed") throw new Error(run.error || "继续提取失败");
		const resultText = run.resultUri || "";
		if (!resultText.trim()) throw new Error("模型返回为空。");

		const add = parseAssetExtraction(resultText);
		// 合并基准 = 最新 store（含续提期间生成的图）；attachSplitPresets 给新增资产挂预设胶囊
		const fresh = useProjectStore.getState();
		const freshCur: ExtractBuckets = {
			characters: fresh.characters || [], scenes: fresh.scenes || [], items: fresh.items || [],
			organisms: fresh.organisms || [], crowds: fresh.crowds || [],
		};
		const { merged, addedCount } = mergeExtraction(freshCur, add, attachSplitPresets);
		fresh.setAnalysisResult({ ...merged, time: analysisTimeLabel() });
		await fresh.save(true);

		let message: string;
		if (addedCount === 0) {
			message = add.truncated
				? "本轮未解析出新资产，但模型输出仍被截断。可再点一次「继续提取」试试。"
				: "✅ 未发现新资产——剧本资产应已提取完整。";
		} else {
			message = `✅ 本轮新增 ${addedCount} 个资产（已与现有合并、未覆盖）。` +
				(add.truncated
					? `输出仍被截断${add.lastLabel ? `（约到「${add.lastLabel}」）` : ""}，可能还有遗漏，请再点「继续提取」继续补全。`
					: `本轮输出完整。可再点一次「继续提取」，若提示"无新增"即代表提取完毕。`);
		}
		return { ok: true, message };
	} catch (err) {
		console.error("Continue extraction failed:", err);
		return { ok: false, message: `继续提取失败：${err instanceof Error ? err.message : "未知错误"}` };
	} finally {
		// 仅当仍是原项目才重置进度/运行态，避免切走后误动新项目的 UI
		if (useProjectStore.getState().projectInstanceId === owner) {
			useProjectStore.getState().setAnalysisProgress(100);
			setTimeout(() => {
				useProjectStore.getState().setAnalysisRunning(false);
				useProjectStore.getState().setAnalysisProgress(0);
			}, 300);
		}
	}
}

/* ════════════════ ④ 分镜：智能推理 / 智能拆分 / 占位入轨 ════════════════ */

/** 整集级互斥锁：智能推理 / 智能拆分 任一在跑（inferTasks 数据源，与 Frame161195 epLocked 同义） */
export function episodeInferLocked(epId: string): boolean {
	return useProjectStore.getState().inferTasks.some(
		(t) => t.episodeId === epId && (t.mode === "multi" || t.mode === "split") && t.status === "running",
	);
}

/**
 * 智能推理（整集多镜）：本集原文 → 每卡 原文+提示词（流式边出边填）。
 * 模板/模型来源与 Frame161195 handleSmartInfer 完全一致（mediaSettings 所选，空=默认；同源走同源模板）。
 */
export async function smartInferEpisode(epId: string): Promise<FlowResult> {
	const st = useProjectStore.getState();
	const ep = st.episodes.find((e) => e.id === epId);
	if (!ep) return { ok: false, message: "分集不存在。" };
	if (!ep.scriptText.trim()) return { ok: false, message: "该集没有剧本原文——先在第②步重新拆分，或到「视频」界面填写本集内容。" };
	if (episodeInferLocked(epId)) return { ok: false, message: "" }; // 推理/拆分任一在跑 → 锁定
	if (ep.shots.length > 0 && !(await confirmDialog("当前分集已有分镜，智能推理将删除当前提示词并覆盖。继续？"))) {
		return { ok: false, message: "" };
	}
	const ms = st.mediaSettings;
	const sameSource = ms.imgVideoSameSource ?? false;
	useProjectStore.getState().setEpisodeShots(epId, []); // 覆盖：清空整集（流式边出边填）
	const { SMART_INFER_MULTI_TPL, SMART_INFER_UNIFIED_TPL } = await import("@/lib/smartInferPrompts");
	const { startInfer } = await import("@/services/inferRun");
	const mtpl = sameSource ? ((ms.unifiedTplId ?? "") || SMART_INFER_UNIFIED_TPL) : ((ms.inferTplId ?? "") || SMART_INFER_MULTI_TPL);
	startInfer({
		episodeId: epId, mode: "multi", sameSource, templateId: mtpl,
		variables: { 原文: ep.scriptText, 视觉风格: useProjectStore.getState().visualStyle || "", ...buildAssetListVars() },
		modelKey: effectiveModelKey("text") || undefined,
	});
	return { ok: true, message: "" };
}

/**
 * 智能拆分（整集，只拆原文分段不含提示词）。模板固定 storyboard.split.smart，
 * 与 Frame161195 handleSplit 完全一致。
 */
export async function smartSplitEpisode(epId: string): Promise<FlowResult> {
	const st = useProjectStore.getState();
	const ep = st.episodes.find((e) => e.id === epId);
	if (!ep) return { ok: false, message: "分集不存在。" };
	if (!ep.scriptText.trim()) return { ok: false, message: "该集没有剧本原文——先在第②步重新拆分，或到「视频」界面填写本集内容。" };
	if (episodeInferLocked(epId)) return { ok: false, message: "" };
	if (ep.shots.length > 0 && !(await confirmDialog("当前分集已有分镜，智能拆分将删除并重新拆分。继续？"))) {
		return { ok: false, message: "" };
	}
	useProjectStore.getState().setEpisodeShots(epId, []);
	const { SMART_SPLIT_TPL } = await import("@/lib/smartInferPrompts");
	const { startInfer } = await import("@/services/inferRun");
	startInfer({
		episodeId: epId, mode: "split", templateId: SMART_SPLIT_TPL,
		variables: { 原文: ep.scriptText, 视觉风格: useProjectStore.getState().visualStyle || "", ...buildAssetListVars() },
		modelKey: effectiveModelKey("text") || undefined,
	});
	return { ok: true, message: "" };
}

/**
 * 把某分集的分镜按顺序追加为时间轴占位符（幂等；一次 commit=一步撤销；
 * 全部已存在时 appendEpisodePlaceholders 返回原 doc 引用，commit 视为 no-op）。
 */
export function appendEpisodeToTimeline(epId: string): { added: number; skipped: number } | null {
	const st = useProjectStore.getState();
	const ep = st.episodes.find((e) => e.id === epId);
	if (!ep) return null;
	// 分集化：占位入的是**该分集自己的时间轴**——先切过去（rtcStore 订阅同步换档），commit 天然落对档位
	st.switchRtcEpisode(epId);
	let res: AppendPlaceholdersResult | null = null;
	useRtcStore.getState().commit((doc) => {
		const r = appendEpisodePlaceholders(doc, ep, { multiEp: st.episodes.length > 1, resolveBlob: st.blobByUri });
		res = r;
		return r.doc;
	});
	const r = res as AppendPlaceholdersResult | null;
	return r ? { added: r.added, skipped: r.skipped } : null;
}
