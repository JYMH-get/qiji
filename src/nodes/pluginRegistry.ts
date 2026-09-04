import {
	Type,
	ScrollText,
	Image as ImageIcon,
	Clapperboard,
	AudioLines,
	Sparkles,
	FileUp,
	Boxes,
	ListTree,
	LayoutGrid,
	Layers,
	Scissors,
	Upload,
	Bot,
	type LucideIcon,
} from "lucide-react";
import type { Capability, Purpose } from "@/contract";
import type { NodeRuntime } from "@/types";
import { buildManagedAdapter, registerAdapter, getAdapter } from "@/services/modelAdapter";
import { listResumableCanvasTasks } from "@/lib/canvasTaskResume";
import { NODE_SPECS, type NodeSpec, type DisplayKind, type NodeKind, type SpawnSpec, type SpecParamField } from "./nodeSpecs";

/**
 * 第174轮 拆分前后缀预设化：画布拆分裂变的资产图片节点与资产模式同尺挂 画风前缀/类别前后缀
 * 预设胶囊——装饰器由 splitPresetAttach **模块体自注册**进 canvasSpawn，这里只需在裂变前动态加载。
 * ⚠ 不能静态 import splitPresetAttach（它引 projectStore）：useCanvasDrag→pluginRegistry 在
 * debouncedSave 的加载链上，会形成 projectStore↔debouncedSave TDZ 循环（第174轮 vitest 实测炸）。
 */
async function ensureSplitPresetDecorator(): Promise<void> {
	await import("@/lib/splitPresetAttach");
}

/**
 * 节点插件注册表（规范化模板驱动）。
 *
 * 第72轮 画布重做：节点由按能力划分（text/script/image/...）改为按**业务步骤**划分，
 * 统一由 `src/nodes/nodeSpecs.ts` 的声明式 `NodeSpec` 注册。本文件把 spec 映射成
 * `NodePlugin`（供 BaseNode/面板/连线校验经 getPlugin 读取），并保留唯一执行入口
 * `defaultNodeExecute`：runPurpose（经管理端网关）→ 集中轮询 → 落结果/裂变子节点。
 */

export interface PortType {
	name: string;
	formats: string[];
}

export interface NodeAction {
	name: string;
	label: string;
	targetNodeType: string;
	handler: (
		nodeId: string,
		context: {
			store: ReturnType<typeof import("@/store/canvasStore").useCanvasStore.getState>;
			dispatch: (command: unknown) => void;
		}
	) => void;
}

export interface NodePlugin {
	type: string;
	label: string;
	code: string;
	icon: LucideIcon;
	accentVar: string;
	resultKind: string;
	defaultModel: string;
	description?: string;
	category?: string;
	thumbnail?: string | null;
	inputs: PortType[];
	outputs: PortType[];
	canStack?: boolean;
	actions?: NodeAction[];
	execute?: (nodeId: string) => Promise<void>;
	isActive?: boolean;
	isDeleted?: boolean;
	// ── NodeSpec 派生的规范化字段 ──
	/** 结果显示方式 */
	displayKind?: DisplayKind;
	/** 执行方式：run/upload/chat/seed */
	nodeKind?: NodeKind;
	/** 模型能力（null=无模型） */
	capability?: Capability | null;
	/** 运行用途 */
	purpose?: Purpose | null;
	/** 结构化输出契约（元信息） */
	schemaId?: string;
	/** 成功后裂变子节点 */
	spawn?: SpawnSpec;
	/** 内置提示词（调用模型前拼接在输入前作为指令；仅 ai.chat 用） */
	builtinPrompt?: string;
	/** 节点未显式选模板时的默认模板 id（如 智能推理=单分镜）；正文留服务端，客户端只发 templateId */
	defaultTemplateId?: string;
	/** 模板下拉可选的用途集合（缺省=仅 purpose）；同一套解析的节点可跨用途选模板，选中即按其用途执行 */
	templatePurposes?: Purpose[];
	/** 与资产模式一致：发 variables{原文,视觉风格} + catalog 模板，而非整段 prompt */
	useTemplateVars?: boolean;
	/** 成功后把完整文本结果落到一个下游「文本」节点 */
	emitResultText?: boolean;
	/** 节点参数表单（与资产模式一致的固定参数；面板优先用它而非 catalog 模型参数） */
	params?: SpecParamField[];
	/** 是否进调色板 */
	inPalette?: boolean;
}

const plugins = new Map<string, NodePlugin>();

/**
 * 本进程正在跟踪的画布任务 id（提交确认/找回挂载时登记，终态释放）：
 * 防 switchCanvas 来回、重复触发找回时对同一任务重复挂轮询（taskCenter handler 按 taskId 唯一，双挂会互相顶掉）。
 */
const activeCanvasTaskIds = new Set<string>();

/** 请求台账（第204轮）查询口：该任务是否正被画布执行/找回流程跟踪（台账据此绝不双挂轮询） */
export function isCanvasTaskTracked(taskId: string): boolean {
	return activeCanvasTaskIds.has(taskId);
}

export const iconMap: Record<string, LucideIcon> = {
	Type,
	ScrollText,
	ImageIcon,
	Clapperboard,
	AudioLines,
	Sparkles,
	FileUp,
	Boxes,
	ListTree,
	LayoutGrid,
	Layers,
	Scissors,
	Upload,
	Bot,
};

/**
 * 默认节点执行：提交到 runPurpose（经管理端网关 + 集中轮询）。
 * - 媒体类（图/视频/音频）：落资产库 + 回写 resultAssetId。
 * - 文本类：写 node.data.resultText（结果即显示）。
 * - 若 spec.spawn：解析结构化结果，裂变子节点（自动连线 + 填提示词，不自动运行）。
 * - upload/seed/chat 三类不在此执行（无模型 / 由 ChatPanel 驱动）。
 */
export async function defaultNodeExecute(
	nodeId: string,
	opts?: { resumeTask?: { taskId: string; adapterKey: string } },
): Promise<void> {
	const { useCanvasStore } = await import("@/store/canvasStore");
	const node = useCanvasStore.getState().nodes[nodeId];
	if (!node) return;

	const plugin = getPlugin(node.type);
	if (!plugin) return;

	// 请求身份快照（⚠ 第205轮补充2，勿改回「提交确认时现读」）：节点此刻必然在激活画布上——
	// 项目路径/画布 key 在**执行开始**捕获。提交确认回执到达前用户可能已切画布/切项目，
	// 那时现读会把身份记错位 → 任务完成后按错身份找不到节点，被误判「已删除」弹找回通知。
	const ledgerIdentity = await (async () => {
		const { useProjectStore } = await import("@/store/projectStore");
		const ps0 = useProjectStore.getState();
		return {
			projectPath: ps0.savePath ?? "",
			projectName: ps0.name,
			canvasKey: ps0.canvasEpisodeId && ps0.episodes.some((e) => e.id === ps0.canvasEpisodeId)
				? ps0.canvasEpisodeId
				: (ps0.episodes[0]?.id ?? ""),
		};
	})();

	const setRuntime = (patch: Partial<NodeRuntime>) =>
		useCanvasStore.getState().setRuntime(nodeId, patch);

	// 断连找回模式（resumeCanvasNodeTasks 触发）：跳过清场/素材上传/提交，凭持久化凭据重挂轮询接回结果
	const resumeTask = opts?.resumeTask;
	// ── 断连保护（在途任务标记）：提交确认写入 node.data.task（随项目落盘），服务端给出终态后清除。
	// 重开项目/切回画布时 resumeCanvasNodeTasks 凭它重挂轮询（不重新提交、不再扣费）。
	const markNodeTask = (taskId: string, adapterKey: string): void => {
		const cs = useCanvasStore.getState();
		const n = cs.nodes[nodeId];
		if (!n) return;
		useCanvasStore.setState({
			nodes: { ...cs.nodes, [nodeId]: { ...n, data: { ...n.data, task: { taskId, adapterKey, startedAt: Date.now() } } } },
		});
	};
	const clearNodeTask = (): boolean => {
		const cs = useCanvasStore.getState();
		const n = cs.nodes[nodeId];
		if (!n?.data.task) return false; // 节点已删/已切画布（快照里的标记留待下次激活时找回）→ 不清
		const data = { ...n.data };
		delete data.task;
		useCanvasStore.setState({ nodes: { ...cs.nodes, [nodeId]: { ...n, data } } });
		return true;
	};
	// 提交确认：任务凭据立即持久化（找回的关键，与 pendingGens「提交确认即落盘」同款；canvas 档去抖合并写盘）
	const onTaskConfirmed = (taskId: string, adapterKey: string): void => {
		activeCanvasTaskIds.add(taskId);
		markNodeTask(taskId, adapterKey);
		// 请求台账登记（第204轮）：给请求补上身份（项目路径/画布 key/节点 id）并**应用级**持久化——
		// 切画布/切项目/重启后由台账兜底向服务端取结果并按身份投递；正常完成由终态回执销账。
		registerLedger(taskId, adapterKey);
		void import("@/store/projectStore").then((m) => m.useProjectStore.getState().scheduleAutoSave("canvas")).catch(() => {});
	};
	// 台账登记载荷统一从**执行开始时刻**取：节点信息随 params、身份用 ledgerIdentity 快照
	const registerLedger = (taskId: string, adapterKey: string): void => {
		const p = node.data.params;
		void import("@/store/requestLedgerStore").then((m) =>
			m.registerCanvasLedgerTask({
				taskId,
				adapterKey,
				nodeId,
				nodeType: node.type,
				nodeTitle: String(node.data.title ?? plugin.label ?? node.type),
				displayKind: String(plugin.displayKind ?? "text"),
				purpose: String(p.purpose || plugin.purpose || "") || undefined,
				assetName: typeof p.assetName === "string" && p.assetName.trim() ? (p.assetName as string).trim() : undefined,
				idPrefix: typeof p.idPrefix === "string" && p.idPrefix ? (p.idPrefix as string) : undefined,
				identity: ledgerIdentity,
			}),
		).catch(() => {});
	};

	// upload/seed 节点不走通用执行（无模型）。
	// 复位运行态——executionHandlers 在调用前已置 queued，避免卡在「排队中」转圈。
	if (plugin.nodeKind === "upload" || plugin.nodeKind === "seed") {
		setRuntime({ status: "idle", progress: 0 });
		return;
	}

	// 只读结果节点（如「分段」截取产物）：只承载结果，运行=无操作（防误触发生成把结果顶掉）。
	if (node.data.params?.resultOnly === true) {
		setRuntime({ status: "idle", progress: 0 });
		return;
	}

	// AI对话：单轮问答（带上游记忆）。由 run 命令驱动，走专用执行。
	if (plugin.nodeKind === "chat") {
		await runChatNode(nodeId, plugin, node);
		return;
	}

	// script 节点：本地确定性脚本（不调模型），如剧集分集的 4 种切分。
	if (plugin.nodeKind === "script") {
		await runScriptNode(nodeId, plugin, node);
		return;
	}

	const params = node.data.params;
	const { resolveActiveModelKey } = await import("@/services/adapters/channelAdapter");
	const modelKey = resolveActiveModelKey(node.type, params.model, plugin.defaultModel);

	// 模型预检：给出画布特有的精确提示（runPurpose 也会兜底返回 no_model）。
	// 无可用模型（modelKey 为空=catalog 无该能力模型）→ 请求不发出，直接打开「设置 → 管理端」引导连接。
	// 找回模式跳过（轮询只认 adapterKey，不需要生效模型；适配器缺失由轮询层报错）。
	if (!resumeTask && !getAdapter(modelKey)) {
		if (!modelKey) {
			const { useUiStore } = await import("@/store/uiStore");
			useUiStore.getState().openModelSettings();
		}
		setRuntime({
			status: "failed",
			progress: 100,
			error: modelKey
				? `未找到模型适配器「${modelKey}」，请在「设置」中配置管理端并选择模型`
				: `无可用模型：请检查管理端连接与目录拉取后重试（已为你打开设置）`,
		});
		return;
	}

	try {
		// 找回模式：直接恢复运行态（清场在原提交时已做过）；正常提交：排队态起步
		setRuntime(resumeTask ? { status: "running", progress: 30, error: null } : { status: "queued", progress: 0 });

		// 运行即清场：旧结果不压在运行态下面——媒体节点把当前主图归档进 resultHistory
		// （堆叠可回看/切回主图），文本节点清空 resultText；随后节点显示脉冲运行态。
		if (!resumeTask) {
			const cs0 = useCanvasStore.getState();
			const n0 = cs0.nodes[nodeId];
			if (n0) {
				const patch: Partial<typeof n0.data> = {};
				if (isTextDisplay(plugin)) {
					if (typeof n0.data.resultText === "string" && n0.data.resultText) patch.resultText = "";
				} else if (n0.data.resultAssetId) {
					const hist = [...(n0.data.resultHistory || [])];
					if (!hist.includes(n0.data.resultAssetId)) hist.push(n0.data.resultAssetId);
					patch.resultHistory = hist;
					patch.resultAssetId = null;
				}
				if (Object.keys(patch).length) {
					useCanvasStore.setState({ nodes: { ...cs0.nodes, [nodeId]: { ...n0, data: { ...n0.data, ...patch } } } });
				}
			}
		}

		const { resolveMentions } = await import("@/lib/mentionResolver");
		const { resolvePresets } = await import("@/lib/presetSchemes");
		const { mapUpstreamText } = await import("@/lib/upstreamText");
		const { upstreamTextSources } = await import("@/canvas/nodeMaterials");
		// 先解析 @[端口] 引用，再把上游全文动态映射到无正文节点，最后展开预设。
		const promptWithUpstream = mapUpstreamText(
			resolveMentions(nodeId, String(params.prompt || "")),
			upstreamTextSources(nodeId).map((source) => source.text),
		);
		const resolvedPrompt = resolvePresets(promptWithUpstream);

		// 提示词为空但有上游文本连线（如 文本种子 → 资产拆分；图视同源链路的图片/视频节点不内置提示词，
		// 直接用上游「同源提示词」节点的文本——改同源节点即同时改图片与视频的提示词）：自动取上游文本作为输入。
		// ⚠ 图例-only 例外：匹配资产会把「【素材图例】…」写进节点提示词——若剥掉图例后没有正文，
		// 节点语义仍是「用上游文本」，此时取 图例 + 上游文本（否则图例会顶掉同源提示词）。
		let inputText: string;
		if (!resolvedPrompt.trim()) {
			inputText = await collectUpstreamTextForNode(nodeId);
		} else {
			const { stripLegend } = await import("@/lib/shotMaterials");
			if (!stripLegend(resolvedPrompt).trim()) {
				const up = await collectUpstreamTextForNode(nodeId);
				inputText = up.trim() ? `${resolvedPrompt.trimEnd()}\n${up}` : resolvedPrompt;
			} else {
				inputText = resolvedPrompt;
			}
		}
		// 内置提示词：调用模型前拼接在用户输入前（仅 ai.chat 作系统指令）。
		// 资产/分集/分镜/故事板/智能推理等步骤的提示词正文均留服务端，按 templateId/purpose 调用。
		const builtinPromptText = plugin.builtinPrompt;
		let effectivePrompt = builtinPromptText
			? `${builtinPromptText}\n\n${inputText}`
			: inputText;

		// 图视同源「宫格补丁」（仅图片节点）：同源提示词图/视共用、对图片不完美——按同源提示词内镜头数
		// 自动补一个宫格预设（4镜→4宫格/5-6→6宫格/更多→9宫格；数不出默认 4 宫格），等同于人工插预设、程序代劳。
		// 只补图片节点（视频用同源提示词原文）；提示词已含宫格指令（手动插过预设）则不补。
		// ⚠ 必须**上游同源提示词已有内容**（推理出结果之后）才补——effectivePrompt 为空=推理还没出，
		//    无镜头可数，此时不补（第117轮补充7：出结果前不加）。
		if (plugin.displayKind === "image" && effectivePrompt.trim()) {
			const { useCanvasStore: uc } = await import("@/store/canvasStore");
			if (isUnifiedImageNode(uc.getState(), nodeId) && String((params as Record<string, unknown>).gridPatch ?? "auto") !== "off") {
				const { gridPresetForShotCount, countUnifiedShots, presetBody, hasGridInstruction } = await import("@/lib/presetSchemes");
				const mode = String((params as Record<string, unknown>).gridPatch ?? "auto");
				const gid = mode === "auto" ? gridPresetForShotCount(countUnifiedShots(effectivePrompt)) : gridPresetForShotCount(Number(mode));
				const body = gid ? presetBody(gid) : undefined;
				if (body && !hasGridInstruction(effectivePrompt)) effectivePrompt = `${effectivePrompt}\n\n${body}`;
			}
		}

		// 收集本节点素材（图片/视频/音频）：listNodeMaterials 单点枚举——**按加入顺序**（matOrder，
		// 素材只往后加），与素材区显示/图例 @tag 编号恒一致。上游素材的 name 也随枚举取友好名
		// （绑定资产名/节点标题，服务端按名注入 @tag 时不再出现 gen_output 机器文件名）。
		// **与资产模式（Frame161195.genVideo）完全一致**：每个素材都经 @/lib/publicUrl 的 ensurePublicUrl
		// 解析成公网 url（本地 asset:// / blob: / localhost 先上传 OSS），绝不把本地直链发给上游。
		// 保留 id（服务端图生图可按 id 取字节）+ name（服务端按名注入 @tag）。
		const collectMedia = async (): Promise<Record<string, unknown>> => {
			const { listNodeMaterials } = await import("@/canvas/nodeMaterials");
			const { ensurePublicUrl } = await import("@/lib/publicUrl");
			const { isCharacterProjectAsset } = await import("@/lib/projectAssets");
			// 逐个解析为公网 url（与资产模式一致；上传失败则跳过该素材，不发本地直链）
			const images: { id?: string; url: string; name?: string; usage?: "reference" | "identity" }[] = [];
			const videos: typeof images = [];
			const audios: typeof images = [];
			const { useProjectStore: ups } = await import("@/store/projectStore");
			const configuredIdentity = Array.isArray(params.officialAssetIndexes);
			const selectedIdentity = new Set(((params.officialAssetIndexes as unknown[] | undefined) ?? []).map(Number).filter(Number.isInteger));
			let imageIndex = 0;
			for (const it of listNodeMaterials(nodeId)) {
				const url = await ensurePublicUrl(it.url || it.uri, { name: it.name || undefined });
				if (!url) continue;
				// 懒上传（第194轮）：LC- 本地暂存 id **绝不发服务端**——ensurePublicUrl 补传后按
				// srcUri 精确取回真实 TP 资产 id（blobByUri 会先命中 LC 映射，不能用）
				let sendId = it.id && !it.id.startsWith("LC-") ? it.id : undefined;
				if (!sendId) {
					const srcKey = it.url || it.uri;
					const b = Object.values(ups.getState().assetBlobs).find((x) => x.srcUri === srcKey && !x.id.startsWith("LC-"));
					if (b) sendId = b.id;
				}
				const baseRef = { url, ...(it.name ? { name: it.name } : {}), ...(sendId ? { id: sendId } : {}) };
				if (it.media === "image") {
					const identity = it.usage === "identity"
						|| (it.usage === undefined && (configuredIdentity ? selectedIdentity.has(imageIndex) : isCharacterProjectAsset(it.assetId)));
					images.push({ ...baseRef, usage: identity ? "identity" : "reference" });
					imageIndex++;
				}
				else if (it.media === "video") videos.push(baseRef);
				else audios.push(baseRef);
			}
			const media: Record<string, unknown> = {};
			if (images.length) media.images = images;
			if (videos.length) media.videos = videos;
			if (audios.length) media.audios = audios;
			return media;
		};
		// 找回模式不收集素材（ensurePublicUrl 会真上传——找回不重新提交，素材早已随原单发出）
		const connectedMedia = resumeTask ? {} : await collectMedia();

		// 收口：画布节点与表格按键共用唯一提交路径 runPurpose（单例 taskCenter 集中轮询）
		let purpose =
			(params.purpose as Purpose) ||
			plugin.purpose ||
			"script.analyze";
		// 文本处理节点（useTemplateVars）的用途以 spec 为准：历史上模板选择器曾把其它用途的模板
		// （如「智能拆分」storyboard.split）连 purpose 一起写进节点 params，导致资产拆分调错提示词。
		// 媒体节点不受此限（裂变/资产助手按资产类型写 purpose，属正常用法）。
		if (plugin.useTemplateVars && plugin.purpose) purpose = plugin.purpose;
		const { runPurpose } = await import("@/services/purposeRunner");
		// 模板允许用途集 / 默认回退：智能推理节点按**上游类型**动态收敛（第108轮：上游智能推理→仅单卡
		// storyboard.singleShot；上游剧集分集→仅多卡+拆分；无/其他上游→全部）；其余节点用 spec 静态集。
		let allowedPurposes = plugin.templatePurposes ?? (plugin.purpose ? [plugin.purpose] : []);
		let fallbackTemplateId = plugin.defaultTemplateId;
		if (node.type === "smart.infer" && plugin.useTemplateVars) {
			const { smartInferContext } = await import("@/lib/inferUpstream");
			const cs = useCanvasStore.getState();
			const ctx = smartInferContext(nodeId, cs.nodes, cs.edges);
			allowedPurposes = ctx.purposes;
			fallbackTemplateId = ctx.defaultTemplateId;
		}
		// 模板：节点显式选择 > 场景默认模板（智能推理按上游：单卡/多卡默认）> 服务端按用途默认。
		let templateId =
			(typeof params.templateId === "string" && params.templateId ? params.templateId : undefined)
			?? fallbackTemplateId;
		// 模板决定用途/自愈：模板用途在允许集内 → 按模板用途执行（多用途节点同一套卡解析）；
		// 不在允许集内（残留/上游改变后失配）→ 回退场景默认模板，并按其用途执行。
		if (templateId && plugin.useTemplateVars) {
			const { useCatalogStore } = await import("@/store/catalogStore");
			const catTpls = useCatalogStore.getState().catalog?.templates;
			const tpl = catTpls?.find((t) => t.id === templateId);
			if (tpl?.purpose && allowedPurposes.includes(tpl.purpose)) {
				purpose = tpl.purpose;
			} else if (tpl?.purpose) {
				console.warn(`[Node ${nodeId}] 模板「${tpl.name}」(${tpl.purpose}) 不在该节点允许用途内（${allowedPurposes.join("/")}），改用场景默认模板`);
				templateId = templateId === fallbackTemplateId ? undefined : fallbackTemplateId;
				const fb = templateId ? catTpls?.find((t) => t.id === templateId) : undefined;
				if (fb?.purpose && allowedPurposes.includes(fb.purpose)) purpose = fb.purpose;
				else if (allowedPurposes.length) purpose = allowedPurposes[0];
			}
		}
		// 合并素材：connectedMedia 已是 上游连线+自加 的**按加入顺序**全量合并（listNodeMaterials），
		// 按媒体分组整组落入 input；其它非媒体 input 键保留。
		const selfInput = (node.data.input || {}) as Record<string, unknown>;
		const mergedInput: Record<string, unknown> = { ...selfInput };
		for (const g of ["images", "videos", "audios"] as const) {
			if (Array.isArray(connectedMedia[g]) && (connectedMedia[g] as unknown[]).length) mergedInput[g] = connectedMedia[g];
			else delete mergedInput[g];
		}
		// 流式增量裂变：资产拆分/智能推理每出完一项就立刻生成子节点（不等任务结束）。
		// episodes/shots 走本地脚本路径（runScriptNode），不经此。
		await ensureSplitPresetDecorator(); // 裂变前完成 资产提示词挂胶囊 装饰器注册（第174轮）
		const { IncrementalSpawner } = await import("@/lib/canvasSpawn");
		const { dispatchCommand } = await import("@/command/dispatch");

		// 画布资产拆分与剧本页**同一条入库链路**（单数据源）：流式期间边解析边合并落库
		// （资产进五类界面/分配编号/写视觉圣经；mergeApply 归属校验防串台、纯合并不覆盖已有）。
		const isAssetSplit = plugin.spawn?.source === "assets";
		const ingestOwner = isAssetSplit
			? (await import("@/store/projectStore")).useProjectStore.getState().projectInstanceId
			: "";
		const liveIngest = async (text: string, final: boolean) => {
			if (!isAssetSplit || !text || text.length <= 40) return;
			try {
				const { parseAssetExtraction } = await import("@/lib/assetExtraction");
				const { mergeApply, analysisTimeLabel } = await import("@/lib/assetMerge");
				const ex = parseAssetExtraction(text);
				const total = ex.characters.length + ex.scenes.length + ex.items.length + ex.organisms.length + ex.crowds.length;
				if (total > 0) {
					mergeApply(
						ingestOwner,
						{ characters: ex.characters, scenes: ex.scenes, items: ex.items, organisms: ex.organisms, crowds: ex.crowds },
						ex.visualBible,
						final ? analysisTimeLabel() : "解析中…",
					);
				} else if (ex.visualBible.style || ex.visualBible.colorSystem || ex.visualBible.negativeGlobal) {
					const ps = (await import("@/store/projectStore")).useProjectStore.getState();
					if (ps.projectInstanceId === ingestOwner) ps.setVisualBible(ex.visualBible);
				}
			} catch (err) {
				console.warn(`[Node ${nodeId}] 资产入库失败：`, err);
			}
		};
		// 分镜原文节点自跑：本节点就是裂变行首的「分镜n原文」（标题匹配 + 上游也是智能推理节点）——
		// 重跑推理时卡片只裂变 故事板/视频 接到自身，且完成后恢复显示**原文**（不是结果 JSON）。
		const { SHOT_SCRIPT_TITLE_RE } = await import("@/lib/canvasSpawn");
		const { resolveCollision } = await import("@/canvas/nodeFactory");
		const { computeBranchPush } = await import("@/lib/branchPush");
		const { useUiStore } = await import("@/store/uiStore");
		const isShotScriptSelf =
			plugin.spawn?.source === "cards" &&
			SHOT_SCRIPT_TITLE_RE.test(String(node.data.title ?? "")) &&
			Object.values(useCanvasStore.getState().edges).some(
				(e) => e.target === nodeId && useCanvasStore.getState().nodes[e.source]?.type === "smart.infer",
			);
		// 找回模式不建流式增量裂变器：关软件前可能已裂变过部分子节点（已随项目持久化），
		// 整批重裂变必重复——找回收尾走 buildRespawn「只补缺漏」（见下方完成分支）。
		const spawner =
			!resumeTask && plugin.spawn && (plugin.spawn.source === "assets" || plugin.spawn.source === "cards")
				? new IncrementalSpawner(node, plugin.spawn, () => useCanvasStore.getState().nodes[nodeId], {
						shotScriptSelf: isShotScriptSelf,
					})
				: null;
		const dispatchBuilt = (built: { nodes: import("@/types").CanvasNode[]; edges: import("@/types").CanvasEdge[] }) => {
			if (built.nodes.length) {
				// 自跑重推理：老的 故事板/视频 节点大概率还在原位——新节点先避让到空位再落子
				if (isShotScriptSelf) {
					const others = Object.values(useCanvasStore.getState().nodes).filter((n) => n.type !== "group");
					const placed: { id: string; type: string; x: number; y: number; w?: number; h?: number }[] = [];
					for (const nd of built.nodes) {
						const free = resolveCollision({ id: nd.id, type: nd.type, x: nd.x, y: nd.y, w: nd.w, h: nd.h }, [
							...others,
							...placed,
						]);
						if (free) {
							nd.x = free.x;
							nd.y = free.y;
						}
						placed.push({ id: nd.id, type: nd.type, x: nd.x, y: nd.y, w: nd.w, h: nd.h });
					}
				}
				// 严格不重叠：新节点落位压到已有节点 → 已有节点连同同枝干**恒向下**让位
				//（与拖动挤开同一套 computeBranchPush；父节点恒不动；「重叠」开关开着时不挤）。
				// 让位坐标随 spawnNodes 同一条命令提交=一次撤销整体回退。
				let pushed: { id: string; x: number; y: number }[] | undefined;
				if (!useUiStore.getState().allowOverlap) {
					const st = useCanvasStore.getState();
					const res = computeBranchPush(
						built.nodes.map((n) => ({ id: n.id, x: n.x, y: n.y, w: n.w, h: n.h })),
						Object.values(st.nodes).map((n) => ({ id: n.id, type: n.type, x: n.x, y: n.y, w: n.w, h: n.h, parentId: n.parentId })),
						Object.values(st.edges),
						{ forceDir: 1, exclude: new Set([nodeId]) },
					);
					if (res) pushed = [...res.moved.entries()].map(([id, p]) => ({ id, x: Math.round(p.x), y: Math.round(p.y) }));
				}
				dispatchCommand({ type: "spawnNodes", parentId: nodeId, nodes: built.nodes, edges: built.edges, pushed });
			}
		};

		const onProgress = (progress: number, status: string, partialText?: string, extra?: { queuePosition?: number; queueTotal?: number; stageText?: string }) => {
			if (status === "queued" || status === "running") {
				// 第251轮：排队情报写进 runtime（无值也要写 undefined——离开排队后必须把上一拍的位次抹掉）
				setRuntime({
					status,
					progress: progress || 10,
					queuePosition: extra?.queuePosition,
					queueTotal: extra?.queueTotal,
					stageText: extra?.stageText,
				});
				// 文本类节点：边收边把部分正文写进节点（结果即显示，流式刷新）
				if (isTextDisplay(plugin) && typeof partialText === "string" && partialText) {
					writeResultText(nodeId, partialText);
					// 每次流式刷新增量解析：已完整的资产/卡片立刻裂变（解析失败静默等下一轮）
					if (spawner) {
						try {
							dispatchBuilt(spawner.feed(partialText));
						} catch (err) {
							console.warn(`[Node ${nodeId}] 流式裂变失败（等待下一轮）：`, err);
						}
					}
					// 资产拆分：流式合并入库（提取一个并入一个，与剧本页一致）
					void liveIngest(partialText, false);
				}
			}
		};
		const sharedInput = Object.keys(mergedInput).length ? mergedInput : undefined;

		// 出图参数与资产模式一致：质量 + 比例×分辨率→size。视频参数(时长/分辨率/比例)键名已对齐服务端，直接透传。
		let runParams: Record<string, unknown> = params;
		if (plugin.capability === "image") {
			const { buildImageParams, imageResolutionOptions } = await import("@/lib/genParams");
			const { useCatalogStore } = await import("@/store/catalogStore");
			// 分辨率档按模型下发（catalog params.resolution 枚举）；残留档不在开放集时提交前归一
			runParams = { ...params, ...buildImageParams(params, imageResolutionOptions(useCatalogStore.getState().model(modelKey))) };
		}
		if (plugin.capability === "video") {
			// 第131轮：方法/要求按 catalog 模型收敛（仅管理端模型——本地 CLI 模型无 catalog，参数由 adapter 自管不动）
			const { useCatalogStore } = await import("@/store/catalogStore");
			const { modelMethods, clampMethod, videoReqOptions, clampToOptions, clampDurationTo } = await import("@/lib/videoMethods");
			const catModel = useCatalogStore.getState().model(modelKey);
			if (catModel) {
				const methods = modelMethods(catModel);
				const req = videoReqOptions(catModel);
				runParams = { ...runParams };
				if (runParams.duration !== undefined) runParams.duration = clampDurationTo(Math.round(Number(runParams.duration)) || 15, req.durations);
				if (typeof runParams.resolution === "string") runParams.resolution = clampToOptions(runParams.resolution, req.resolutions);
				if (typeof runParams.aspect_ratio === "string") runParams.aspect_ratio = clampToOptions(runParams.aspect_ratio, req.aspects);
				if (methods.length > 1) {
					const method = clampMethod(runParams.method, methods);
					runParams.method = method;
					// 首尾帧前置校验（与服务端同尺）：素材图片（上游连线+自加，合并序）第 1 张=首帧、第 2 张=尾帧
					// （找回模式素材未收集、也不重新提交——跳过，防误报）
					if (!resumeTask && method === "frames" && ((mergedInput.images as unknown[] | undefined)?.length ?? 0) < 2) {
						setRuntime({ status: "failed", progress: 100, error: "首尾帧方法需要两张图片素材（第 1 张=首帧、第 2 张=尾帧），请连上游图片或在素材区添加后重试" });
						return;
					}
				} else {
					delete runParams.method; // 换回仅全能参考的模型：残留方法值不生效也不发
				}
			}
		}
		// 注：智能推理(inferTemplates)输出极长，走下方 useTemplateVars 分支(已放宽 maxTokens 65535)。

		let run;
		if (resumeTask) {
			// 断连找回：跳过组装与提交，凭持久化的 taskId+adapterKey 重挂集中轮询（不重新提交、不再扣费）
			activeCanvasTaskIds.add(resumeTask.taskId);
			// 台账补登（幂等 upsert）：台账上线前/被清空后的存量在途任务也获得身份与全局兜底
			registerLedger(resumeTask.taskId, resumeTask.adapterKey);
			run = await runPurpose(purpose, { resumeTask, onProgress });
		} else if (plugin.useTemplateVars) {
			// 与资产模式一致：发 variables{原文,视觉风格,资产列表,当前时间} + 默认 catalog 模板（不发整段 prompt），
			// 由管理端模板拼接提示词；长文本放宽 maxTokens 防截断（配合 parseAssetExtraction 截断兜底）。
			const { useProjectStore } = await import("@/store/projectStore");
			const { buildAssetListVars } = await import("@/lib/assetVars");
			const visualStyle = useProjectStore.getState().visualStyle || "";
			const now0 = new Date();
			const p2 = (v: number) => String(v).padStart(2, "0");
			// 与资产模式各步骤变量完全对齐：原文 + 视觉风格 + 角色/场景/物品/生物/群像列表
			// （智能推理靠它输出 {角色:名} 等公式、资产拆分靠它查重续提）+ 当前时间（+「分镜数量」）
			const variables: Record<string, string> = {
				原文: inputText,
				视觉风格: visualStyle,
				...buildAssetListVars(),
				当前时间: `${now0.getFullYear()}/${p2(now0.getMonth() + 1)}/${p2(now0.getDate())} ${p2(now0.getHours())}:${p2(now0.getMinutes())}:${p2(now0.getSeconds())}`,
			};
			if ("shotCount" in params) {
				const sc = Number(params.shotCount);
				variables.分镜数量 = sc > 0 ? String(sc) : "自动";
			}
			run = await runPurpose(purpose, {
				variables,
				// 文本参数与资产模式完全一致：固定 temperature/maxTokens（节点不开放温度/长度选择，
				// 历史节点残留的 temperature/maxTokens 也不生效）
				params: { ...params, temperature: 0.7, maxTokens: 65535 },
				input: sharedInput,
				modelKey,
				templateId,
				onProgress,
				onTaskId: onTaskConfirmed,
			});
		} else {
			// 文本类节点同样收口（媒体节点参数为时长/比例/分辨率等，照常透传）
			if (plugin.capability === "text") {
				runParams = { ...runParams, temperature: 0.7, maxTokens: 65535 };
			}
			run = await runPurpose(purpose, {
				prompt: effectivePrompt,
				params: runParams,
				input: sharedInput,
				modelKey,
				templateId,
				onProgress,
				onTaskId: onTaskConfirmed,
			});
		}

		// 服务端已给出终态（success/failed 均是定论）：释放进程内跟踪守卫 + 清除持久化在途标记。
		// 清除放在结果落地之前——落地本身失败也不该让下次启动再去找回一个已终态的任务。
		if (run.status !== "no_model" && run.taskId) activeCanvasTaskIds.delete(run.taskId);
		if (clearNodeTask()) {
			void import("@/store/projectStore").then((m) => m.useProjectStore.getState().scheduleAutoSave("canvas")).catch(() => {});
		}

		// 请求台账终态回执（第204轮）：成功且节点仍在激活画布=下方落盘代码会写进节点 → 销账；
		// 节点不在（运行期间切了画布/节点被删）=结果缓存进台账并立即按身份投递（非激活画布直写
		// 快照 / 目标已删 → 找回通知）；失败=销账（失败已自动退款，无可找回）。
		if (run.status !== "no_model" && run.taskId) {
			const nodeAlive = !!useCanvasStore.getState().nodes[nodeId];
			const args = run.status === "success"
				? { taskId: run.taskId, success: true, delivered: nodeAlive, resultUri: run.resultUri, assetId: run.assetId, rawLink: run.rawLink }
				: { taskId: run.taskId, success: false, delivered: false };
			void import("@/store/requestLedgerStore").then((m) => m.ledgerOnCanvasTerminal(args)).catch(() => {});
		}

		if (run.status !== "success") {
			setRuntime({
				status: "failed",
				progress: 100,
				error: run.status === "no_model" ? "未配置可用模型" : run.error,
			});
			return;
		}

		if (isTextDisplay(plugin)) {
			// 文本类：写 resultText（结果即显示），不入媒体资产库
			writeResultText(nodeId, run.resultUri || "");
		} else {
			// 媒体类：落资产库 + 回写节点 resultAssetId
			const { useLibraryStore } = await import("@/store/libraryStore");
			const { saveRemoteAsset, uploadBlobToOss } = await import("@/services/assetPersist");
			const { useProjectStore } = await import("@/store/projectStore");
			const assetId = `asset-${run.taskId ?? nodeId}`;
			const remoteUrl = run.resultUri || "";
			// 与资产模式一致：把结果下载到本地（asset://，Tauri CSP img-src/media-src 不允许 https 直显）；
			// 登记三元映射（供下游 ensurePublicUrl 取回公网 url）。直链未能落本地时请管理端转存 OSS 再下载。
			let displayUri = remoteUrl;
			let localPath: string | null = null;
			let serverAssetId: string | null = run.assetId ?? null;
			try {
				// rawLink（第158轮）：服务端未转存（meta.rehosted=false，remoteUrl=上游原始时效直链）
				// → 客户端本机网络快重试下载（图 3×30s / 视频 2×120s）
				const dl = run.rawLink
					? (plugin.displayKind === "video" ? { attempts: 2, timeoutSecs: 120 } : { attempts: 3, timeoutSecs: 30 })
					: undefined;
				let blob = await saveRemoteAsset(run.assetId || assetId, remoteUrl, dl);
				// 下载成功 → 本地字节经上传接口传回服务端落 OSS，id/url 换成台账记录（原始直链会过期）
				if (blob && run.rawLink) {
					const upPrefix = typeof params.idPrefix === "string" && params.idPrefix
						? (params.idPrefix as string)
						: plugin.displayKind === "video" ? "video" : "TP";
					const upName = typeof params.assetName === "string" && (params.assetName as string).trim()
						? (params.assetName as string).trim()
						: `${plugin.type}_output`;
					const beforeId = blob.id;
					// 带 taskId=顺带改写服务端任务响应体（rehosted→true，断连找回不再重复接力转存）
					blob = await uploadBlobToOss(blob, upName, upPrefix, run.taskId);
					if (blob.id !== beforeId) serverAssetId = blob.id; // 上传成功：以 OSS 台账 id 为准（id 是真理）
				}
				if (!blob && /^https?:\/\//i.test(remoteUrl)) {
					const { managedClient } = await import("@/services/managedClient");
					const re = await managedClient.rehost(remoteUrl, undefined, `${plugin.type}_output`);
					if (re?.url) blob = await saveRemoteAsset(re.id, re.url);
				}
				if (blob) {
					useProjectStore.getState().registerAssetBlob(blob);
					displayUri = blob.localUri || remoteUrl;
					localPath = blob.localPath || null;
				}
			} catch (e) {
				console.warn(`[Node ${nodeId}] 结果落盘失败：`, e);
			}
			// 产物名：资产节点（裂变自资产拆分，params 带 assetName）用**资产名**——节点标题即资产名
			// （BaseNode 标题显示的是产物资产名），与资产模式一致；非资产节点保留时间戳名。
			const assetName = typeof params.assetName === "string" ? (params.assetName as string).trim() : "";
			useLibraryStore.getState().addAsset({
				id: assetId,
				kind: (plugin.displayKind as "image" | "video" | "audio") ?? "image",
				name: assetName || `${plugin.type}_output_${Date.now()}`,
				uri: displayUri,
				serverAssetId,
				thumbnailUri: null,
				createdAt: new Date().toISOString(),
				deletedByUser: false,
				localPath,
				origin: "generated", // 节点生成产物 → 不进「本地素材库」
				// 分集归属（三模同步）：产物归**执行开始时所在画布**的分集（实时剪辑素材页按分集过滤）
				episodeId: ledgerIdentity.canvasKey || null,
			});
			// 收录进项目资产库（=资产助手按分类可见，与资产模式同一条写回：addAssetImage 主图+历史）。
			// 按 idPrefix 定分类、按资产名回查（变体名形如「父名 · 造型名」→ 写回父资产的对应变体）。
			if (assetName && plugin.displayKind === "image") {
				try {
					const PREFIX_CAT: Record<string, "characters" | "crowds" | "scenes" | "organisms" | "items"> = {
						C: "characters", A: "characters", G: "crowds", S: "scenes", M: "organisms", P: "items",
					};
					const idPrefix = typeof params.idPrefix === "string" ? (params.idPrefix as string) : "";
					const cat = PREFIX_CAT[idPrefix] ?? "characters";
					const ps2 = useProjectStore.getState();
					const arr = (ps2[cat] || []) as Array<{ id: string; name: string; variants?: Array<{ id: string; label?: string; name?: string }> }>;
					const [baseName, variantLabel] = assetName.split(" · ").map((s) => s.trim());
					const parent = arr.find((a) => String(a.name).trim() === baseName);
					if (parent) {
						let variantId: string | null = null;
						let variantOk = true;
						if (variantLabel) {
							const v = (parent.variants || []).find(
								(x) => String(x.label || "").trim() === variantLabel || String(x.name || "").trim() === variantLabel || String(x.name || "").trim() === assetName,
							);
							if (v) variantId = v.id;
							else variantOk = false; // 找不到对应造型：不写（写基础主图会拿变体图覆盖本体）
						}
						if (variantOk) ps2.addAssetImage(cat, parent.id, variantId, displayUri, true);
					}
				} catch (e) {
					console.warn(`[Node ${nodeId}] 结果写回项目资产失败：`, e);
				}
			}
			const cs = useCanvasStore.getState();
			if (cs.nodes[nodeId]) {
				const prevHist = cs.nodes[nodeId].data.resultHistory || [];
				const resultMetaByAssetId = {
					...(cs.nodes[nodeId].data.resultMetaByAssetId || {}),
					[assetId]: {
						model: run.modelKey || modelKey,
						aspect: String(runParams.aspect_ratio ?? runParams.aspect ?? runParams.ratio ?? ""),
						duration: runParams.duration as number | string | undefined,
						prompt: effectivePrompt,
						createdAt: new Date().toISOString(),
					},
				};
				useCanvasStore.setState({
					nodes: {
						...cs.nodes,
						[nodeId]: {
							...cs.nodes[nodeId],
							// 新结果设为主图，并入历史（旧→新；堆叠展开可回看/切回）
							data: { ...cs.nodes[nodeId].data, resultAssetId: assetId, resultHistory: prevHist.includes(assetId) ? prevHist : [...prevHist, assetId], resultMetaByAssetId },
						},
					},
				});
			}
		}

		setRuntime({ status: "success", progress: 100 });

		// 资产拆分：终态按完整全文合并落库（写入「最近分析时间」，与剧本页一致）
		await liveIngest(run.resultUri || "", true);

		// 裂变收尾：流式期间未闭合/未判定完整的项在此按完整全文补齐；
		// 全程一项都没解析出来 → 明确报错（旧逻辑静默跳过，看起来像"节点被屏蔽"）。
		if (spawner) {
			try {
				dispatchBuilt(spawner.feed(run.resultUri || "", true));
				if (spawner.total === 0) {
					const what = plugin.spawn?.source === "cards" ? "分镜卡" : "资产";
					setRuntime({
						status: "failed",
						progress: 100,
						error: `生成完成，但未能从输出中解析出任何${what}（请检查模型输出/提示词模板格式，节点内可查看原始输出）`,
					});
				} else if (isShotScriptSelf) {
					// 分镜原文节点自跑：解析成功后恢复显示**原文**（结果已裂变成 故事板/视频 节点，
					// 本节点的展示内容始终是本镜原文，不是推理结果 JSON）
					writeResultText(nodeId, String(node.data.params.prompt ?? ""));
				}
			} catch (err) {
				console.warn(`[Node ${nodeId}] 裂变收尾失败：`, err);
			}
		} else if (resumeTask && plugin.spawn && (plugin.spawn.source === "assets" || plugin.spawn.source === "cards")) {
			// 断连找回收尾：关软件前流式期间可能已裂变过部分子节点（已随项目持久化）——绝不整批重裂变，
			// 走「二次解析」同款 buildRespawn：与画布已有子节点比对、只补缺漏（幂等，全齐=零新增）。
			try {
				await ensureSplitPresetDecorator();
				const { buildRespawn } = await import("@/lib/canvasSpawn");
				const cs3 = useCanvasStore.getState();
				const cur = cs3.nodes[nodeId];
				if (cur) {
					const built = buildRespawn(cur, plugin.spawn, run.resultUri || "", cs3.nodes, cs3.edges);
					dispatchBuilt(built);
					if (built.parsed === 0) {
						const what = plugin.spawn.source === "cards" ? "分镜卡" : "资产";
						setRuntime({
							status: "failed",
							progress: 100,
							error: `生成完成，但未能从输出中解析出任何${what}（请检查模型输出/提示词模板格式，节点内可查看原始输出）`,
						});
					} else if (isShotScriptSelf) {
						// 分镜原文节点：找回后同样恢复显示原文（结果已按缺漏补入 故事板/视频 节点）
						writeResultText(nodeId, String(cur.data.params.prompt ?? ""));
					}
				}
			} catch (err) {
				console.warn(`[Node ${nodeId}] 找回后补齐裂变失败：`, err);
			}
		} else if (plugin.emitResultText && run.resultUri && !resumeTask) {
			// 结果文本节点（如生成故事板）：落一个下游「文本」节点承载完整结果
			try {
				const { buildSpawn } = await import("@/lib/canvasSpawn");
				// 相对定位：按父节点**当前**位置落子（运行期间用户可能已拖动主节点）
				const cur = useCanvasStore.getState().nodes[nodeId] ?? node;
				const built = buildSpawn(cur, { spawn: plugin.spawn, emitResultText: plugin.emitResultText }, run.resultUri);
				dispatchBuilt(built);
			} catch (err) {
				console.warn(`[Node ${nodeId}] spawn 失败：`, err);
			}
		}

		const { useProjectStore } = await import("@/store/projectStore");
		useProjectStore.getState().scheduleAutoSave("history");
	} catch (err) {
		// 找回模式的内部异常：释放跟踪守卫（任务标记仍在，可下次激活画布时再找回）
		if (resumeTask) activeCanvasTaskIds.delete(resumeTask.taskId);
		console.error(`[Node ${nodeId}] execute failed:`, err);
		setRuntime({
			status: "failed",
			progress: 100,
			error: err instanceof Error ? err.message : "请求发送失败",
		});
	}
}

/**
 * 画布在途任务断连找回（与资产模式 resumePendingGenerations 同责）：项目加载 / switchCanvas 后调用。
 * 扫当前激活画布节点持久化的 data.task（提交确认时写入），凭 taskId+adapterKey 重挂轮询——
 * **不重新提交、不再扣费**；结果走 defaultNodeExecute 同一条落地路径（写文本/落资产/buildRespawn 补裂变）。
 * 已在本进程跟踪中的任务跳过（switchCanvas 来回时原轮询仍活着，双挂会互相顶掉 taskCenter handler）；
 * 先按缓存 catalog 同步注册 ManagedAdapter，网络同步未回时也能立刻挂上轮询。
 */
export function resumeCanvasNodeTasks(): void {
	void (async () => {
		try {
			const { syncManagedAdapters } = await import("@/services/adapters/managedAdapter");
			syncManagedAdapters();
		} catch { /* 无缓存 catalog：适配器缺失由轮询层报「未找到适配器」 */ }
		const { useCanvasStore } = await import("@/store/canvasStore");
		for (const t of listResumableCanvasTasks(useCanvasStore.getState().nodes, activeCanvasTaskIds)) {
			activeCanvasTaskIds.add(t.taskId); // 同步占位防重入双挂（defaultNodeExecute 终态/异常时释放）
			defaultNodeExecute(t.nodeId, { resumeTask: { taskId: t.taskId, adapterKey: t.adapterKey } }).catch((err) => {
				activeCanvasTaskIds.delete(t.taskId);
				console.warn(`[Node ${t.nodeId}] 画布在途任务找回失败：`, err);
			});
		}
	})();
}

function isTextDisplay(plugin: NodePlugin): boolean {
	return plugin.displayKind === "text" || plugin.displayKind === "chat";
}

/**
 * 图视同源图片节点判定：本节点是图片节点，且其上游「文本源」节点（同源提示词）同时还连了一个视频节点
 * —— 即「同源提示词 → 图片 + 视频」并联结构。宫格补丁只补这种图片节点（视频用同源提示词原文）。
 */
export function isUnifiedImageNode(
	cs: { nodes: Record<string, import("@/types").CanvasNode>; edges: Record<string, { source: string; target: string }> },
	nodeId: string,
): boolean {
	const node = cs.nodes[nodeId];
	if (!node || getPlugin(node.type)?.displayKind !== "image") return false;
	const textUpstream: string[] = [];
	for (const e of Object.values(cs.edges)) {
		if (e.target !== nodeId) continue;
		const p = getPlugin(cs.nodes[e.source]?.type);
		if (p && (p.displayKind === "text" || p.displayKind === "chat" || p.nodeKind === "seed")) textUpstream.push(e.source);
	}
	if (!textUpstream.length) return false;
	for (const e of Object.values(cs.edges)) {
		if (!textUpstream.includes(e.source) || e.target === nodeId) continue;
		if (getPlugin(cs.nodes[e.target]?.type)?.displayKind === "video") return true;
	}
	return false;
}

/**
 * 取连入本节点的上游**文本**（单输入点：按上游节点类型分流，不依赖端口名）。
 * 只收文本类上游（文本/对话/种子）；媒体上游(图/视频/音频)由 collectConnectedMedia 处理。
 */
async function collectUpstreamTextForNode(nodeId: string): Promise<string> {
	const { useCanvasStore } = await import("@/store/canvasStore");
	const cs0 = useCanvasStore.getState();
	const texts: string[] = [];
	for (const edge of Object.values(cs0.edges)) {
		if (edge.target !== nodeId) continue;
		const up = cs0.nodes[edge.source];
		if (!up) continue;
		const upPlugin = getPlugin(up.type);
		const isTextSrc = upPlugin?.displayKind === "text" || upPlugin?.displayKind === "chat" || upPlugin?.nodeKind === "seed";
		if (!isTextSrc) continue;
		const t = typeof up.data.resultText === "string" && up.data.resultText.trim()
			? up.data.resultText
			: typeof up.data.params.prompt === "string" ? (up.data.params.prompt as string) : "";
		if (t.trim()) texts.push(t);
	}
	return texts.join("\n\n");
}

/**
 * script 节点：本地确定性脚本（不调模型）。当前用于「剧集分集」——按所选方式切分输入文本，
 * 裂变出每集「文本」节点（复用 buildSpawn：把切分结果转成 episodes JSON 走既有裂变路径）。
 */
async function runScriptNode(nodeId: string, plugin: NodePlugin, node: import("@/types").CanvasNode): Promise<void> {
	// 转深度节点：本地深度推理（不调模型、零计费）——运行=重新转深度，**绝不走生图管线**（第198轮）
	if (node.type === "image.depth") {
		const { rerunDepthNode } = await import("@/canvas/depthify");
		await rerunDepthNode(nodeId);
		return;
	}
	// 视频转深度节点（第206轮，与 image.depth 同规矩）：运行=重新逐帧转深度，**绝不走生视频管线**
	if (node.type === "video.depth") {
		const { rerunVideoDepthNode } = await import("@/canvas/videoDepthify");
		await rerunVideoDepthNode(nodeId);
		return;
	}
	const { useCanvasStore } = await import("@/store/canvasStore");
	const setRuntime = (patch: Partial<NodeRuntime>) => useCanvasStore.getState().setRuntime(nodeId, patch);
	try {
		setRuntime({ status: "running", progress: 50 });
		const params = node.data.params;
		const { resolveMentions } = await import("@/lib/mentionResolver");
		const { mapUpstreamText } = await import("@/lib/upstreamText");
		const { upstreamTextSources } = await import("@/canvas/nodeMaterials");
		const resolved = mapUpstreamText(
			resolveMentions(nodeId, String(params.prompt || "")),
			upstreamTextSources(nodeId).map((source) => source.text),
		);
		const inputText = resolved.trim() ? resolved : await collectUpstreamTextForNode(nodeId);
		if (!inputText.trim()) {
			setRuntime({ status: "failed", progress: 100, error: "没有可拆分的文本（请连入上游文本或在面板输入）" });
			return;
		}

		let resultJson = "";
		if (plugin.spawn?.source === "episodes") {
			const { splitEpisodes } = await import("@/lib/episodeSplit");
			const eps = splitEpisodes(inputText, String(params.splitMode || "n-n")); // 兜底与 spec 默认一致（n-n，第121轮）
			if (!eps.length) {
				setRuntime({ status: "failed", progress: 100, error: "未按所选方式找到分集标记（如行首 1-1 或「第N集」），请换一种分集方式" });
				return;
			}
			resultJson = JSON.stringify({ episodes: eps.map((e, i) => ({ index: i + 1, title: e.title, summary: e.scriptText })) });
		}

		if (plugin.spawn && resultJson) {
			const { buildSpawn } = await import("@/lib/canvasSpawn");
			const { dispatchCommand } = await import("@/command/dispatch");
			const cur = useCanvasStore.getState().nodes[nodeId] ?? node;
			const built = buildSpawn(cur, { spawn: plugin.spawn }, resultJson);
			if (built.nodes.length) {
				// 严格不重叠：分集裂变落位同样把压到的已有节点向下挤开（与 dispatchBuilt 同语义）
				const { computeBranchPush } = await import("@/lib/branchPush");
				const { useUiStore } = await import("@/store/uiStore");
				let pushed: { id: string; x: number; y: number }[] | undefined;
				if (!useUiStore.getState().allowOverlap) {
					const st = useCanvasStore.getState();
					const res = computeBranchPush(
						built.nodes.map((n) => ({ id: n.id, x: n.x, y: n.y, w: n.w, h: n.h })),
						Object.values(st.nodes).map((n) => ({ id: n.id, type: n.type, x: n.x, y: n.y, w: n.w, h: n.h, parentId: n.parentId })),
						Object.values(st.edges),
						{ forceDir: 1, exclude: new Set([nodeId]) },
					);
					if (res) pushed = [...res.moved.entries()].map(([id, p]) => ({ id, x: Math.round(p.x), y: Math.round(p.y) }));
				}
				dispatchCommand({ type: "spawnNodes", parentId: nodeId, nodes: built.nodes, edges: built.edges, pushed });
			}
		}
		setRuntime({ status: "success", progress: 100 });
		const { useProjectStore } = await import("@/store/projectStore");
		useProjectStore.getState().scheduleAutoSave("history");
	} catch (err) {
		setRuntime({ status: "failed", progress: 100, error: err instanceof Error ? err.message : "拆分失败" });
	}
}

/** 一对问答（上游记忆走链） */
interface ChatPair { question: string; answer: string; skipped: boolean }

/** 取某 AI对话节点的问/答（问=params.question，答=resultText） */
function chatNodeQA(node: import("@/types").CanvasNode): { question: string; answer: string } {
	const p = node.data.params;
	const question = String(p.question ?? p.prompt ?? "");
	const answer = typeof node.data.resultText === "string" ? node.data.resultText : "";
	return { question, answer };
}

/**
 * 沿连线向上收集 AI对话祖先（root-first），用于「记忆」：上游每个对话节点的一问一答。
 * 链式（一个对话只接一个上游对话）；标记「跳过」的节点其问答在 buildChatPrompt 处被剔除
 * （效果＝上游与下游相连、跳过该节点）。
 */
function gatherChatAncestors(
	nodeId: string,
	cs: ReturnType<typeof import("@/store/canvasStore").useCanvasStore.getState>,
): ChatPair[] {
	const pairs: ChatPair[] = [];
	const seen = new Set<string>([nodeId]);
	let cur = nodeId;
	for (let guard = 0; guard < 200; guard++) {
		let upId: string | null = null;
		for (const e of Object.values(cs.edges)) {
			if (e.target !== cur) continue;
			const up = cs.nodes[e.source];
			if (up?.type === "ai.chat") { upId = up.id; break; }
		}
		if (!upId || seen.has(upId)) break;
		seen.add(upId);
		const up = cs.nodes[upId];
		const { question, answer } = chatNodeQA(up);
		pairs.unshift({ question, answer, skipped: !!up.data.params.skipped });
		cur = upId;
	}
	return pairs;
}

/** 组装对话提示词：内置系统指令 + 上游一问一答（跳过 skipped）+ 本轮提问 */
function buildChatPrompt(
	nodeId: string,
	question: string,
	builtin: string | undefined,
	cs: ReturnType<typeof import("@/store/canvasStore").useCanvasStore.getState>,
): string {
	const ancestors = gatherChatAncestors(nodeId, cs).filter(
		(p) => !p.skipped && (p.question.trim() || p.answer.trim()),
	);
	const lines: string[] = [];
	for (const p of ancestors) {
		if (p.question.trim()) lines.push(`用户：${p.question.trim()}`);
		if (p.answer.trim()) lines.push(`助手：${p.answer.trim()}`);
	}
	lines.push(`用户：${question}`);
	lines.push("助手：");
	return (builtin ? `${builtin}\n\n` : "") + lines.join("\n\n");
}

/** 答完后自动新建一个下游 AI对话节点（已有对话后继则不重复创建） */
async function autoSpawnDownstreamChat(nodeId: string): Promise<void> {
	const { useCanvasStore } = await import("@/store/canvasStore");
	const cs = useCanvasStore.getState();
	const node = cs.nodes[nodeId];
	if (!node) return;
	const hasChatChild = Object.values(cs.edges).some(
		(e) => e.source === nodeId && cs.nodes[e.target]?.type === "ai.chat",
	);
	if (hasChatChild) return;
	const { makeNode, NODE_W } = await import("@/canvas/nodeFactory");
	const { genId } = await import("@/lib/id");
	const child = makeNode("ai.chat", node.x + (node.w || NODE_W) + 90, node.y);
	child.parentScriptId = nodeId;
	const edge: import("@/types").CanvasEdge = {
		id: genId("edge"),
		kind: "dataflow",
		source: nodeId,
		sourcePort: "out",
		target: child.id,
		targetPort: "in",
	};
	const { dispatchCommand } = await import("@/command/dispatch");
	dispatchCommand({ type: "spawnNodes", parentId: nodeId, nodes: [child], edges: [edge] });
}

/**
 * AI对话节点执行：单轮问答 + 上游记忆。
 * - 提问取 params.question；答写 resultText（结果即显示、流式刷新）。
 * - 上游对话节点的一问一答作为记忆（可逐节点「跳过」剔除）。
 * - 首次答成后锁定提问（只能重新回答、不能改问）、并自动新建下游对话节点。
 */
async function runChatNode(
	nodeId: string,
	plugin: NodePlugin,
	node: import("@/types").CanvasNode,
): Promise<void> {
	const { useCanvasStore } = await import("@/store/canvasStore");
	const setRuntime = (patch: Partial<NodeRuntime>) => useCanvasStore.getState().setRuntime(nodeId, patch);
	// 同步写答（+可选 params 补丁），避免 writeResultText 异步导入造成的竞态
	const writeAnswer = (text: string, paramsPatch?: Record<string, unknown>) => {
		const cs2 = useCanvasStore.getState();
		const n = cs2.nodes[nodeId];
		if (!n) return;
		useCanvasStore.setState({
			nodes: {
				...cs2.nodes,
				[nodeId]: {
					...n,
					data: {
						...n.data,
						resultText: text,
						params: paramsPatch ? { ...n.data.params, ...paramsPatch } : n.data.params,
					},
				},
			},
		});
	};

	const params = node.data.params;
	const question = String(params.question ?? params.prompt ?? "").trim();
	if (!question) {
		setRuntime({ status: "failed", progress: 100, error: "请先在面板填写提问" });
		return;
	}

	const { resolveActiveModelKey } = await import("@/services/adapters/channelAdapter");
	const modelKey = resolveActiveModelKey("ai.chat", params.model, plugin.defaultModel);
	if (!getAdapter(modelKey)) {
		if (!modelKey) {
			const { useUiStore } = await import("@/store/uiStore");
			useUiStore.getState().openModelSettings();
		}
		setRuntime({
			status: "failed",
			progress: 100,
			error: modelKey ? `未找到模型适配器「${modelKey}」` : "无可用文本模型：请检查管理端连接与目录拉取后重试（已为你打开设置）",
		});
		return;
	}

	const prompt = buildChatPrompt(nodeId, question, plugin.builtinPrompt, useCanvasStore.getState());
	const images = Array.isArray(params.images)
		? (params.images as { id?: string; url?: string }[]).filter((i) => i && i.url)
		: [];

	try {
		setRuntime({ status: "queued", progress: 0 });
		writeAnswer(""); // 清空旧答，准备流式刷新
		const { runPurpose } = await import("@/services/purposeRunner");
		const run = await runPurpose("chat.reply", {
			prompt,
			modelKey,
			input: images.length ? { images: images.map((i) => ({ id: i.id, url: i.url })) } : undefined,
			onProgress: (progress, status, partial) => {
				if (status === "queued" || status === "running") {
					setRuntime({ status, progress: progress || 10 });
					if (typeof partial === "string" && partial) writeAnswer(partial);
				}
			},
		});
		if (run.status !== "success") {
			setRuntime({
				status: "failed",
				progress: 100,
				error: run.status === "no_model" ? "未配置可用文本模型" : run.error,
			});
			return;
		}
		// 答成：写最终答 + 锁定提问（只能重新回答）
		writeAnswer(run.resultUri || "（模型未返回内容）", { questionLocked: true });
		setRuntime({ status: "success", progress: 100 });
		await autoSpawnDownstreamChat(nodeId);
		const { useProjectStore } = await import("@/store/projectStore");
		useProjectStore.getState().scheduleAutoSave("history");
	} catch (err) {
		setRuntime({ status: "failed", progress: 100, error: err instanceof Error ? err.message : "请求发送失败" });
	}
}

/** 把文本结果写入节点 data.resultText（结果即显示 / 流式刷新） */
function writeResultText(nodeId: string, text: string): void {
	import("@/store/canvasStore").then(({ useCanvasStore }) => {
		const cs = useCanvasStore.getState();
		const n = cs.nodes[nodeId];
		if (!n) return;
		useCanvasStore.setState({
			nodes: { ...cs.nodes, [nodeId]: { ...n, data: { ...n.data, resultText: text } } },
		});
	});
}

export function registerPlugin(plugin: NodePlugin) {
	if (!plugin.execute) {
		plugin.execute = defaultNodeExecute;
	}
	plugins.set(plugin.type, plugin);
}

export function getPlugin(type: string): NodePlugin | undefined {
	return plugins.get(type);
}

export function listPlugins(): NodePlugin[] {
	return Array.from(plugins.values());
}

/** 把一个规范化 NodeSpec 注册为 NodePlugin（并为 run/chat 类合成兜底网关适配器，携带其参数表单） */
export function registerNodeSpec(spec: NodeSpec) {
	const nodePlugin: NodePlugin = {
		type: spec.type,
		label: spec.label,
		code: spec.type.toUpperCase(),
		icon: iconMap[spec.iconName] || Sparkles,
		accentVar: spec.accentVar,
		resultKind: spec.display,
		defaultModel: "",
		description: spec.description || "",
		category: spec.category,
		thumbnail: null,
		inputs: spec.inputs.map((p) => ({ name: p.name, formats: p.formats })),
		outputs: spec.outputs.map((p) => ({ name: p.name, formats: p.formats })),
		canStack: false,
		actions: [],
		execute: defaultNodeExecute,
		isActive: true,
		isDeleted: false,
		displayKind: spec.display,
		nodeKind: spec.kind,
		capability: spec.capability,
		purpose: spec.purpose,
		schemaId: spec.schemaId,
		spawn: spec.spawn,
		builtinPrompt: spec.builtinPrompt,
		defaultTemplateId: spec.defaultTemplateId,
		templatePurposes: spec.templatePurposes,
		useTemplateVars: spec.useTemplateVars,
		emitResultText: spec.emitResultText,
		params: spec.params,
		inPalette: spec.inPalette,
	};
	plugins.set(spec.type, nodePlugin);

	// ⚠ 不再注册「__fallback 兜底适配器」（§9 模型解析零兜底）：它曾被面板 adapters[0] 兜底选中、
	// 经 onRun 落进节点 params.model 并真发 /v1/generate（服务端报「模型不存在」）。
	// 无可用模型时统一走 openModelSettings 引导去「设置 → 管理端」连接，请求不发出。
}

/** 自定义插件的能力推断（导入/热加载 JSON 插件用；内置节点走 NodeSpec.capability） */
const CAP_BY_TYPE: Record<string, Capability> = {
	text: "text",
	script: "text",
	image: "image",
	video: "video",
	audio: "audio",
};

/**
 * 注册一个自定义声明式插件（来自 .qiji-plugin.json 导入 / pluginWatcher 热加载）。
 * 纯数据驱动：节点 UI 来自 JSON 字段；若声明了 adapter.modes 且能推断能力，则合成一个
 * 经管理端网关的 ManagedAdapter（携带这些 modes 作为面板参数表单），不执行任何脚本。
 */
export function registerSerializedPlugin(plugin: any) {
	const type: string = plugin.type || plugin.id;
	if (!type) return;

	const nodePlugin: NodePlugin = {
		type,
		label: plugin.label || plugin.name || type,
		code: plugin.code || type.toUpperCase(),
		icon: iconMap[plugin.iconName] || Sparkles,
		accentVar: plugin.accentVar || "var(--node-accent)",
		resultKind: plugin.resultKind || type,
		defaultModel: plugin.defaultModel || plugin.adapter?.key || "",
		description: plugin.description || "",
		category: plugin.category || "other",
		thumbnail: plugin.thumbnail || null,
		inputs: plugin.inputs || [],
		outputs: plugin.outputs || [],
		canStack: plugin.canStack,
		actions: [],
		execute: defaultNodeExecute,
		isActive: plugin.isActive !== false,
		isDeleted: !!plugin.isDeleted,
		displayKind: plugin.resultKind || "text",
		nodeKind: "run",
		inPalette: true,
	};
	plugins.set(type, nodePlugin);

	const modes = plugin.adapter?.modes as unknown[] | undefined;
	const cap = CAP_BY_TYPE[type];
	if (modes && modes.length && cap) {
		const adapterKey: string = plugin.adapter?.key || type;
		const baseCost: number = plugin.adapter?.baseCost ?? 10;
		const adapter = buildManagedAdapter({
			id: adapterKey,
			label: plugin.adapter?.displayName || nodePlugin.label,
			capability: cap,
			params: [],
			cost: baseCost,
		});
		adapter.modes = modes as typeof adapter.modes;
		adapter.nodeTypes = [type as (typeof adapter.nodeTypes)[number]];
		adapter.vendor = plugin.adapter?.vendor || "管理端";
		adapter.estimateCost = (_modeKey, params) => baseCost * (Number(params?.quantity) || 1);
		registerAdapter(adapter);
	}
}

// ── 加载内置声明式节点（规范化 NodeSpec）──
for (const spec of NODE_SPECS) {
	registerNodeSpec(spec);
}
