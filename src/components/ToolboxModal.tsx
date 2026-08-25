/**
 * ToolboxModal —— 大厅「AI 工具箱」弹窗（第245轮）。
 *
 * 入口：大厅侧栏「工具」图标。卡片式工具清单（参考竞品 AI 工具箱样式）→ 点卡进入具体工具：
 *  - 小说转剧本：粘贴小说原文 → 文本模型改写为分场剧本（流式显示；复制/导出 .txt）
 *  - 封面生成：描述 + 比例/分辨率/质量 → 图像模型出海报级封面（会话历史；保存到本地）
 *
 * 提示词正文全在服务端模板（tool.novel2script / tool.cover.main，管理端「AI 工具」分类可调优），
 * 客户端只传 templateId + 变量；生成与计费走 runPurpose 唯一路径。状态在 toolboxStore（会话级，
 * 生成中关闭弹窗不中断）。工具不依赖已打开的项目，模型选择为工具本地态（不写 projectModelConfig）。
 */
import { useEffect, useMemo, useState } from "react";
import { X, ArrowLeft, Wrench, BookOpenText, ImagePlus, Loader2, Copy, Download, Check, Wand2 } from "lucide-react";
import { useToolboxStore } from "@/store/toolboxStore";
import { useCatalogStore } from "@/store/catalogStore";
import ModelPicker, { useCapModelOptions } from "@/components/ModelPicker";
import TemplatePicker from "@/components/TemplatePicker";
import { IMAGE_QUALITIES, IMAGE_ASPECTS, imageResolutionOptions, clampImageResolution, resolveSize, estimateCost } from "@/lib/genParams";
import { saveTextToLocal, saveUriToLocal } from "@/lib/saveMedia";

/** 工具卡（首页网格） */
function ToolCard({ icon, iconBg, title, desc, onClick }: {
	icon: React.ReactNode;
	iconBg: string;
	title: string;
	desc: string;
	onClick: () => void;
}) {
	return (
		<button
			onClick={onClick}
			className="flex flex-col items-start gap-3 rounded-xl border border-border/40 bg-secondary/30 hover:bg-secondary/60 p-5 text-left transition-colors cursor-pointer"
		>
			<span className="flex h-11 w-11 items-center justify-center rounded-xl" style={{ background: iconBg }}>
				{icon}
			</span>
			<span className="text-sm font-semibold text-foreground">{title}</span>
			<span className="text-[11px] text-muted-foreground leading-relaxed">{desc}</span>
		</button>
	);
}

/** 小说转剧本工具视图 */
function NovelTool() {
	const novel = useToolboxStore((s) => s.novel);
	const patchNovel = useToolboxStore((s) => s.patchNovel);
	const runNovel = useToolboxStore((s) => s.runNovel);
	const opts = useCapModelOptions("text");
	const effKey = novel.modelKey && opts.some((o) => o.id === novel.modelKey) ? novel.modelKey : opts[0]?.id ?? "";
	const models = useCatalogStore((s) => s.catalog?.models);
	const model = useMemo(() => models?.find((m) => m.id === effKey), [models, effKey]);
	const cost = estimateCost(model, {});
	const [copied, setCopied] = useState(false);

	const outputText = novel.running ? novel.partial : novel.result;

	const handleCopy = async () => {
		if (!novel.result) return;
		try {
			await navigator.clipboard.writeText(novel.result);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch { /* 剪贴板不可用时静默 */ }
	};

	return (
		<div className="flex flex-col gap-3">
			{/* 控制行：模型 / 模板 / 预估 / 执行 */}
			<div className="flex items-end gap-3 flex-wrap">
				<ModelPicker cap="text" label="文本模型" value={novel.modelKey} onChange={(id) => patchNovel({ modelKey: id })} style={{ minWidth: 220 }} />
				<TemplatePicker purpose="script.toScenes" value={novel.tplId} onChange={(id) => patchNovel({ tplId: id })} style={{ minWidth: 160 }} />
				<div className="ml-auto flex items-center gap-3">
					{cost != null && <span className="text-[10px] text-muted-foreground">预计消耗 {cost} 积分</span>}
					<button
						onClick={() => void runNovel(effKey)}
						disabled={novel.running || !novel.input.trim()}
						className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-[12px] font-semibold hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
					>
						{novel.running ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> 转换中 {Math.round(novel.progress)}%</> : <><Wand2 className="h-3.5 w-3.5" /> 开始转换</>}
					</button>
				</div>
			</div>
			{novel.error && <div className="text-[11px] text-destructive">{novel.error}</div>}

			{/* 左原文 / 右剧本 */}
			<div className="grid grid-cols-2 gap-3">
				<div className="flex flex-col gap-1.5">
					<div className="flex items-center justify-between text-[11px] text-muted-foreground">
						<span>小说原文</span>
						<span>{novel.input.length.toLocaleString()} 字</span>
					</div>
					<textarea
						value={novel.input}
						onChange={(e) => patchNovel({ input: e.target.value })}
						placeholder="把小说原文粘贴到这里…"
						className="h-[340px] w-full resize-none rounded-lg border border-border/40 bg-secondary/30 p-3 text-[12px] leading-relaxed text-foreground outline-none focus:border-primary/50 Qiji-scroll-thin"
					/>
				</div>
				<div className="flex flex-col gap-1.5">
					<div className="flex items-center justify-between text-[11px] text-muted-foreground">
						<span>分场剧本{novel.running ? "（实时生成中…）" : ""}</span>
						<div className="flex items-center gap-2">
							<button
								onClick={() => void handleCopy()}
								disabled={!novel.result}
								className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
							>
								{copied ? <><Check className="h-3 w-3 text-green-400" /> 已复制</> : <><Copy className="h-3 w-3" /> 复制</>}
							</button>
							<button
								onClick={() => void saveTextToLocal(novel.result, `剧本-${new Date().toISOString().slice(0, 10)}`)}
								disabled={!novel.result}
								className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
							>
								<Download className="h-3 w-3" /> 导出 .txt
							</button>
						</div>
					</div>
					<textarea
						value={outputText}
						readOnly
						placeholder="转换结果将显示在这里（可在新建项目后粘贴进剧本编辑器）"
						className="h-[340px] w-full resize-none rounded-lg border border-border/40 bg-secondary/20 p-3 text-[12px] leading-relaxed text-foreground outline-none Qiji-scroll-thin"
					/>
				</div>
			</div>
			<p className="text-[10px] text-muted-foreground">
				转换按所选文本模型正常计费；结果不自动存入项目——复制或导出后，粘贴到项目的剧本编辑器即可继续分集/分镜。
			</p>
		</div>
	);
}

/** 封面生成工具视图 */
function CoverTool() {
	const cover = useToolboxStore((s) => s.cover);
	const patchCover = useToolboxStore((s) => s.patchCover);
	const runCover = useToolboxStore((s) => s.runCover);
	const opts = useCapModelOptions("image");
	const effKey = cover.modelKey && opts.some((o) => o.id === cover.modelKey) ? cover.modelKey : opts[0]?.id ?? "";
	const models = useCatalogStore((s) => s.catalog?.models);
	const model = useMemo(() => models?.find((m) => m.id === effKey), [models, effKey]);
	// 分辨率档随生效模型 catalog 收敛（与资产模式一把尺）
	const resOpts = imageResolutionOptions(model);
	const resolution = clampImageResolution(cover.resolution, resOpts);
	const cost = estimateCost(model, { size: resolveSize(cover.aspect, resolution), quality: cover.quality });
	// 预览选中的历史项（-1=最新）
	const [selIdx, setSelIdx] = useState(0);
	const sel = cover.results[selIdx] ?? cover.results[0];

	const handleRun = () => {
		patchCover({ resolution });
		setSelIdx(0);
		void runCover(effKey);
	};

	const selSt = "w-full rounded-md border border-border/40 bg-secondary/30 px-2 py-1.5 text-[12px] text-foreground outline-none cursor-pointer";

	return (
		<div className="flex gap-4">
			{/* 左：参数 */}
			<div className="flex w-[280px] flex-shrink-0 flex-col gap-3">
				<div className="flex flex-col gap-1.5">
					<span className="text-[11px] text-muted-foreground">封面内容描述</span>
					<textarea
						value={cover.desc}
						onChange={(e) => patchCover({ desc: e.target.value })}
						placeholder="描述封面：主体人物/场景、氛围、风格…（例：黑衣少年立于雨夜霓虹街头，冷色调，赛博武侠风）"
						className="h-[130px] w-full resize-none rounded-lg border border-border/40 bg-secondary/30 p-3 text-[12px] leading-relaxed text-foreground outline-none focus:border-primary/50 Qiji-scroll-thin"
					/>
				</div>
				<div className="flex flex-col gap-1.5">
					<span className="text-[11px] text-muted-foreground">比例</span>
					<div className="flex gap-1.5">
						{IMAGE_ASPECTS.map((a) => (
							<button
								key={a.v}
								onClick={() => patchCover({ aspect: a.v })}
								className={`flex-1 rounded-md border px-2 py-1.5 text-[11px] cursor-pointer transition-colors ${cover.aspect === a.v ? "border-primary/60 bg-primary/20 text-foreground font-semibold" : "border-border/40 bg-secondary/30 text-muted-foreground hover:text-foreground"}`}
							>
								{a.label}
							</button>
						))}
					</div>
				</div>
				<div className="grid grid-cols-2 gap-2">
					<label className="flex flex-col gap-1.5 text-[11px] text-muted-foreground">
						分辨率
						<select value={resolution} onChange={(e) => patchCover({ resolution: e.target.value })} className={selSt}>
							{resOpts.map((r) => <option key={r.v} value={r.v} style={{ background: "#1f1f2e" }}>{r.label}</option>)}
						</select>
					</label>
					<label className="flex flex-col gap-1.5 text-[11px] text-muted-foreground">
						质量
						<select value={cover.quality} onChange={(e) => patchCover({ quality: e.target.value })} className={selSt}>
							{IMAGE_QUALITIES.map((q) => <option key={q} value={q} style={{ background: "#1f1f2e" }}>{q}</option>)}
						</select>
					</label>
				</div>
				<ModelPicker cap="image" label="图像模型" value={cover.modelKey} onChange={(id) => patchCover({ modelKey: id })} />
				<TemplatePicker purpose="image.cover" value={cover.tplId} onChange={(id) => patchCover({ tplId: id })} />
				<div className="flex items-center justify-between">
					{cost != null ? <span className="text-[10px] text-muted-foreground">预计消耗 {cost} 积分</span> : <span />}
				</div>
				<button
					onClick={handleRun}
					disabled={cover.running || !cover.desc.trim()}
					className="flex items-center justify-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-[12px] font-semibold text-primary-foreground hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
				>
					{cover.running ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> 生成中 {Math.round(cover.progress)}%</> : <><ImagePlus className="h-3.5 w-3.5" /> 生成封面</>}
				</button>
				{cover.error && <div className="text-[11px] text-destructive">{cover.error}</div>}
			</div>

			{/* 右：预览 + 历史 */}
			<div className="flex min-w-0 flex-1 flex-col gap-2">
				<div className="flex h-[380px] items-center justify-center overflow-hidden rounded-lg border border-border/40 bg-secondary/20">
					{sel ? (
						<img src={sel.objUrl || sel.url} alt="封面" className="max-h-full max-w-full object-contain" />
					) : (
						<span className="px-6 text-center text-[11px] leading-relaxed text-muted-foreground">
							生成的封面将显示在这里{"\n"}可保存到本地，或在新建项目时用作项目封面
						</span>
					)}
				</div>
				<div className="flex items-center justify-between gap-2">
					<div className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto Qiji-scroll-thin">
						{cover.results.map((r, i) => (
							<button
								key={r.at}
								onClick={() => setSelIdx(i)}
								className={`h-12 w-12 flex-shrink-0 overflow-hidden rounded-md border cursor-pointer ${sel === r ? "border-primary" : "border-border/40 opacity-70 hover:opacity-100"}`}
								title={new Date(r.at).toLocaleTimeString()}
							>
								<img src={r.objUrl || r.url} alt="" className="h-full w-full object-cover" />
							</button>
						))}
					</div>
					<button
						onClick={() => sel && void saveUriToLocal(sel.objUrl || sel.url, `封面-${new Date(sel.at).toISOString().slice(0, 19).replace(/[:T]/g, "-")}`, "image")}
						disabled={!sel}
						className="flex flex-shrink-0 items-center gap-1 rounded-lg bg-secondary px-3 py-1.5 text-[11px] text-foreground hover:bg-secondary/70 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
					>
						<Download className="h-3 w-3" /> 保存图片
					</button>
				</div>
				<p className="text-[10px] text-muted-foreground">按所选图像模型正常计费；历史仅保留本次会话最近 12 张。</p>
			</div>
		</div>
	);
}

const TOOL_TITLES: Record<string, string> = { novel: "小说转剧本", cover: "封面生成" };

export function ToolboxModal() {
	const setOpen = useToolboxStore((s) => s.setOpen);
	const view = useToolboxStore((s) => s.view);
	const setView = useToolboxStore((s) => s.setView);

	// Esc 关闭（工具视图先退回首页）
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			const v = useToolboxStore.getState().view;
			if (v === "home") setOpen(false);
			else setView("home");
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [setOpen, setView]);

	return (
		<div
			className="fixed inset-0 z-[20000] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-200"
			onClick={() => setOpen(false)}
		>
			<div
				className={`Qiji-panel flex flex-col ${view === "home" ? "w-[640px]" : "w-[880px]"} max-h-[88vh] rounded-2xl text-foreground shadow-2xl overflow-hidden relative transition-[width] duration-200`}
				style={{ border: "1px solid rgba(255, 255, 255, 0.1)" }}
				onClick={(e) => e.stopPropagation()}
			>
				{/* Header */}
				<div className="flex items-center justify-between px-6 pt-5 pb-3">
					<div className="flex items-center gap-2">
						{view !== "home" && (
							<button
								onClick={() => setView("home")}
								className="text-muted-foreground hover:text-foreground hover:bg-secondary rounded-lg p-1 transition-colors cursor-pointer"
								title="返回工具箱"
							>
								<ArrowLeft className="h-4 w-4" />
							</button>
						)}
						<Wrench className="h-4 w-4 text-primary" />
						<div>
							<h3 className="text-sm font-semibold text-foreground">{view === "home" ? "AI 工具箱" : TOOL_TITLES[view]}</h3>
							{view === "home" && <p className="text-[10px] text-muted-foreground mt-0.5">独立的 AI 辅助小工具，无需打开项目即可使用</p>}
						</div>
					</div>
					<button
						onClick={() => setOpen(false)}
						className="text-muted-foreground hover:text-foreground hover:bg-secondary rounded-lg p-1 transition-colors cursor-pointer"
					>
						<X className="h-4 w-4" />
					</button>
				</div>

				<div className="flex-1 overflow-y-auto px-6 pb-5 Qiji-scroll-thin">
					{view === "home" && (
						<div className="grid grid-cols-3 gap-3 pt-1">
							<ToolCard
								icon={<BookOpenText className="h-5 w-5" style={{ color: "#6890F8" }} />}
								iconBg="rgba(104,144,248,0.16)"
								title="小说转剧本"
								desc="小说原文智能改写为分场剧本"
								onClick={() => setView("novel")}
							/>
							<ToolCard
								icon={<ImagePlus className="h-5 w-5" style={{ color: "#34c98e" }} />}
								iconBg="rgba(52,201,142,0.16)"
								title="封面生成"
								desc="AI 智能生成精美封面图"
								onClick={() => setView("cover")}
							/>
						</div>
					)}
					{view === "novel" && <NovelTool />}
					{view === "cover" && <CoverTool />}
				</div>
			</div>
		</div>
	);
}
