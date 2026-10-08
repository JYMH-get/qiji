import { useProjectStore } from "@/store/projectStore";
import { useCatalogStore } from "@/store/catalogStore";
import { getDualModeFeature } from "@/store/connectionStore";
import { effectiveModelKey } from "@/components/ModelPicker";
import { confirmDialog } from "@/lib/confirmDialog";
import { buildAssetListVars } from "@/lib/assetVars";
import {
	normalInferenceStrategy, projectInferenceDuration,
	projectInferenceStrategy, resolveSplitTemplate, resolveStrategyTemplate,
} from "@/lib/inferenceStrategy";
import type { StartInferSpec } from "@/services/inferRun";
import type { FlowResult } from "./flowActions";

// 两个入口共用同步准备锁：确认弹窗与动态加载期间也不能再提交同集。
const preparing = new Map<string, symbol>();
const preparationKey = (owner: string, episodeId: string) => JSON.stringify([owner, episodeId]);
const silent = (): FlowResult => ({ ok: false, message: "" });

function running(episodeId: string): boolean {
	return useProjectStore.getState().inferTasks.some(task => task.episodeId === episodeId
		&& (task.mode === "multi" || task.mode === "split") && task.status === "running");
}

/** 整集推理/拆分共用锁，包含尚未受理的确认与准备阶段。 */
export function episodeInferLocked(episodeId: string): boolean {
	const owner = useProjectStore.getState().projectInstanceId;
	return preparing.has(preparationKey(owner, episodeId)) || running(episodeId);
}

async function inferEpisode(episodeId: string, mode: "multi" | "split"): Promise<FlowResult> {
	const project = useProjectStore.getState(), owner = project.projectInstanceId;
	if (project.isProjectLoading) return silent();
	const episode = project.episodes.find(ep => ep.id === episodeId);
	if (!episode) return { ok: false, message: "分集不存在。" };
	if (!episode.scriptText.trim()) return { ok: false, message: "该集没有剧本原文，请先填写本集原文。" };
	if (episodeInferLocked(episodeId)) return silent();
	const key = preparationKey(owner, episodeId), token = Symbol(key);
	preparing.set(key, token);
	const alive = () => {
		const current = useProjectStore.getState();
		return current.projectInstanceId === owner && !current.isProjectLoading
			&& current.episodes.some(ep => ep.id === episodeId) && preparing.get(key) === token;
	};
	try {
		// 所有请求配置在首个 await 前快照；弹窗期间的其它设置变动留给下一次提交。
		const settings = structuredClone(project.mediaSettings);
		const templates = useCatalogStore.getState().catalog?.templates ?? [];
		const strategy = structuredClone(normalInferenceStrategy(projectInferenceStrategy(settings), templates));
		const sameSource = !getDualModeFeature() || !!settings.imgVideoSameSource;
		const variables = { 原文: episode.scriptText, 视觉风格: project.visualStyle || "", ...buildAssetListVars() };
		const modelKey = effectiveModelKey("text") || undefined;
		const { durationRange, durationLimit, durationError } = projectInferenceDuration(settings);
		if (durationError) throw new Error(durationError);
		let templateId: string, inference: StartInferSpec["inference"];
		if (mode === "split") {
			const template = resolveSplitTemplate(templates, settings.splitTplId) ?? resolveSplitTemplate(templates);
			if (!template) throw new Error("当前没有可用的拆分方案");
			const outputPurpose = sameSource ? "storyboard.unified" : "storyboard.toVideoPrompt";
			if (!templates.some(t => t.id === `output.${outputPurpose}` && t.purpose === outputPurpose && t.category === "输出提示词")) {
				throw new Error("当前输出格式不可用");
			}
			templateId = template.id;
			inference = { source: "template", outputMode: sameSource ? "unified" : "storyboard", durationRange, durationLimit, guidance: strategy.guidance };
		} else {
			const template = resolveStrategyTemplate(templates, strategy.templateId);
			if (strategy.source === "skill" ? !strategy.skillText?.trim() : !template) {
				throw new Error(strategy.source === "skill" ? "请先导入或填写外部 Skills 内容" : "请选择可用的推理方案");
			}
			templateId = strategy.source === "skill" ? "" : template!.id;
			inference = {
				source: strategy.source ?? "template", skillText: strategy.skillText, skillName: strategy.skillName,
				guidance: strategy.guidance, durationRange, durationLimit,
			};
		}
		if (episode.shots.length > 0) {
			const message = mode === "split"
				? "智能拆分将按顺序更新当前分集的分镜原文与时长，保留已有提示词、成片和剪辑，并追加新分镜。继续？"
				: "智能推理将按顺序更新当前分集的分镜原文、提示词与时长，保留已有成片和剪辑，并追加新分镜。继续？";
			if (!(await confirmDialog(message))) return silent();
			if (!alive() || running(episodeId)) return silent();
		}
		const { startInfer } = await import("@/services/inferRun");
		if (!alive() || running(episodeId)) return silent();
		startInfer({ episodeId, mode, sameSource, templateId, inference, variables, modelKey, rtcAutoPlaceholders: true });
		return { ok: true, message: "" };
	} catch (error) {
		return alive() ? { ok: false, message: error instanceof Error ? error.message : "推理准备失败，请重试。" } : silent();
	} finally {
		if (preparing.get(key) === token) preparing.delete(key);
	}
}

export function smartInferEpisode(episodeId: string): Promise<FlowResult> {
	return inferEpisode(episodeId, "multi");
}

export function smartSplitEpisode(episodeId: string): Promise<FlowResult> {
	return inferEpisode(episodeId, "split");
}
