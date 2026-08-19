import { useRef, useState } from "react";
import { X, Settings, ImagePlus, Loader2, Trash2, FolderOpen } from "lucide-react";
import { useProjectStore, type RecentProject } from "@/store/projectStore";

/** 把上传图片压缩成缩略图 data URL（最长边 512px，webp 0.85），随项目文件与列表持久化。 */
async function fileToThumbnail(file: File, maxSize = 512): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const img = new Image();
			img.onload = () => {
				let { width, height } = img;
				if (width >= height && width > maxSize) {
					height = Math.round((height * maxSize) / width);
					width = maxSize;
				} else if (height > width && height > maxSize) {
					width = Math.round((width * maxSize) / height);
					height = maxSize;
				}
				const canvas = document.createElement("canvas");
				canvas.width = width;
				canvas.height = height;
				const ctx = canvas.getContext("2d");
				if (!ctx) { reject(new Error("无法创建画布上下文")); return; }
				ctx.drawImage(img, 0, 0, width, height);
				resolve(canvas.toDataURL("image/webp", 0.85));
			};
			img.onerror = reject;
			img.src = reader.result as string;
		};
		reader.onerror = reject;
		reader.readAsDataURL(file);
	});
}

interface Props {
	project: RecentProject;
	onClose: () => void;
	/** 保存成功回调（外层可据此刷新展示，例如重新读 recentProjects） */
	onSaved?: () => void;
}

/**
 * 项目设置（管理界面）：修改项目名称与封面。
 * 不需先打开项目——直接改写 .Qiji 文件的 name/coverImage 并同步最近项目列表（updateProjectMeta）。
 */
export function ProjectSettingsModal({ project, onClose, onSaved }: Props) {
	const [name, setName] = useState(project.name || "");
	const [cover, setCover] = useState<string>(project.cover || "");
	const [saving, setSaving] = useState(false);
	const [err, setErr] = useState("");
	const fileRef = useRef<HTMLInputElement>(null);

	const pickCover = async (file?: File | null) => {
		if (!file) return;
		if (!/(jpe?g|png|webp)$/i.test(file.name) && !/(jpe?g|png|webp)$/i.test(file.type)) {
			setErr("仅支持 JPG、PNG、WEBP 格式");
			return;
		}
		if (file.size > 5 * 1024 * 1024) {
			setErr("图片大小不能超过 5MB");
			return;
		}
		setErr("");
		try {
			setCover(await fileToThumbnail(file));
		} catch (e) {
			setErr(`封面处理失败：${(e as Error).message}`);
		}
	};

	const save = async () => {
		const n = name.trim();
		if (!n) { setErr("项目名称不能为空"); return; }
		setSaving(true);
		setErr("");
		try {
			// cover 传当前值（"" 表示清空、字符串表示设值）——始终传，允许清空封面
			await useProjectStore.getState().updateProjectMeta(project.path, { name: n, cover });
			onSaved?.();
			onClose();
		} catch (e) {
			setErr((e as Error).message || "保存失败");
			setSaving(false);
		}
	};

	return (
		<div
			className="fixed inset-0 z-[20000] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-200"
			onClick={onClose}
		>
			<div
				className="Qiji-panel flex flex-col w-[440px] max-h-[85vh] rounded-2xl text-foreground shadow-2xl overflow-hidden"
				style={{ border: "1px solid rgba(255, 255, 255, 0.1)" }}
				onClick={(e) => e.stopPropagation()}
			>
				{/* Header */}
				<div className="flex items-center justify-between px-6 pt-5 pb-3">
					<div>
						<div className="flex items-center gap-2">
							<Settings className="h-4 w-4 text-primary" />
							<h3 className="text-sm font-semibold text-foreground">项目设置</h3>
						</div>
						<p className="text-[10px] text-muted-foreground mt-0.5">修改项目名称与封面</p>
					</div>
					<button
						onClick={onClose}
						className="text-muted-foreground hover:text-foreground hover:bg-secondary rounded-lg p-1 transition-colors cursor-pointer"
					>
						<X className="h-4 w-4" />
					</button>
				</div>

				<div className="flex-1 overflow-y-auto px-6 py-4 Qiji-scroll-thin flex flex-col gap-5">
					{/* 名称 */}
					<div className="flex flex-col gap-2">
						<label className="text-xs font-semibold text-foreground">项目名称</label>
						<input
							value={name}
							onChange={(e) => setName(e.target.value)}
							onKeyDown={(e) => { if (e.key === "Enter") void save(); }}
							placeholder="输入项目名称"
							autoFocus
							className="bg-secondary/40 border border-border/40 rounded-lg px-3 py-2 text-[13px] text-foreground outline-none focus:border-primary/60"
						/>
					</div>

					{/* 封面 */}
					<div className="flex flex-col gap-2">
						<label className="text-xs font-semibold text-foreground">项目封面</label>
						<input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => void pickCover(e.target.files?.[0])} />
						<div className="relative w-full aspect-[16/9] rounded-xl overflow-hidden border border-border/40 bg-secondary/30">
							{cover ? (
								<>
									<img src={cover} alt="项目封面" className="absolute inset-0 w-full h-full object-cover" />
									<button
										onClick={() => setCover("")}
										title="移除封面"
										className="absolute top-2 right-2 w-7 h-7 rounded-full bg-black/60 hover:bg-red-500/80 text-white flex items-center justify-center transition-colors cursor-pointer"
									>
										<Trash2 className="h-3.5 w-3.5" />
									</button>
								</>
							) : (
								<button
									onClick={() => fileRef.current?.click()}
									className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted-foreground hover:text-foreground hover:bg-secondary/40 transition-colors cursor-pointer"
								>
									<ImagePlus className="h-6 w-6" />
									<span className="text-[11px]">点击上传项目封面（JPG/PNG/WEBP，≤5MB）</span>
								</button>
							)}
						</div>
						{cover && (
							<button
								onClick={() => fileRef.current?.click()}
								className="self-start flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-secondary/50 hover:bg-secondary text-[11px] text-foreground transition-colors cursor-pointer"
							>
								<ImagePlus className="h-3.5 w-3.5" /> 更换封面
							</button>
						)}
					</div>

					{/* 项目路径（只读，便于确认改的是哪个项目） */}
					<div className="flex flex-col gap-1.5">
						<label className="text-xs font-semibold text-foreground flex items-center gap-1.5">
							<FolderOpen className="h-3.5 w-3.5 text-muted-foreground" /> 项目位置
						</label>
						<p className="text-[10px] text-muted-foreground font-mono break-all bg-secondary/30 border border-border/30 rounded-lg px-3 py-2">
							{project.path}
						</p>
					</div>

					{err && <div className="text-[11px] text-destructive">{err}</div>}
				</div>

				{/* Footer */}
				<div className="flex justify-end gap-2 px-6 py-4 border-t border-border/40">
					<button
						onClick={onClose}
						className="px-5 py-2 rounded-lg bg-secondary text-foreground hover:bg-secondary/80 font-semibold cursor-pointer transition-colors text-xs"
					>
						取消
					</button>
					<button
						onClick={save}
						disabled={saving || !name.trim()}
						className="flex items-center gap-1.5 px-5 py-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 font-semibold cursor-pointer transition-colors text-xs disabled:opacity-50 disabled:cursor-not-allowed"
					>
						{saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Settings className="h-3.5 w-3.5" />}
						保存
					</button>
				</div>
			</div>
		</div>
	);
}
