import { remapBodyTags } from "@/lib/shotMaterials";

export type RtcFrameRole = "first" | "last";
export interface RtcFrameReference {
	media?: "image" | "video" | "audio";
	rtcFrameRole?: RtcFrameRole;
}
const isImage = (ref: RtcFrameReference) => !ref.media || ref.media === "image";
export const isRtcFrameReference = (ref: RtcFrameReference): boolean =>
	isImage(ref) && (ref.rtcFrameRole === "first" || ref.rtcFrameRole === "last");

/** Replacing a role keeps its slot; ordinary references and their numbering do not move. */
export function replaceRtcFrameReference<T extends RtcFrameReference>(refs: readonly T[], role: RtcFrameRole, frame: T): T[] {
	const index = refs.findIndex(ref => isImage(ref) && ref.rtcFrameRole === role);
	const next = [...refs], value = { ...frame, media: "image" as const, rtcFrameRole: role };
	if (index < 0) next.push(value);
	else next[index] = value;
	return next;
}

/** Request-only copy. No role means the legacy storyboard/firstFrameUrl protocol remains unchanged. */
export function planRtcVideoFrames<T extends RtcFrameReference>(
	refs: readonly T[], prompt: string,
	options: { method?: string; includeReferences?: boolean; storyboard?: T } = {},
): { refs: T[]; prompt: string; explicitFrames: boolean } {
	const explicitFrames = refs.some(isRtcFrameReference);
	let selected = refs.filter(ref => options.includeReferences !== false || isRtcFrameReference(ref));
	if (!explicitFrames) return { refs: selected, prompt, explicitFrames };
	if (options.storyboard) selected = [...selected, options.storyboard];
	let images = selected.filter(isImage);
	if (options.method === "frames") {
		const explicitLast = images.find(ref => ref.rtcFrameRole === "last");
		const first = images.find(ref => ref.rtcFrameRole === "first") ?? options.storyboard ?? images.find(ref => ref !== explicitLast);
		const last = explicitLast ?? images.find(ref => ref !== first);
		images = [...new Set([first, last, ...images].filter((ref): ref is T => !!ref))];
		let index = 0;
		selected = selected.map(ref => isImage(ref) ? images[index++] : ref);
	}
	const oldImages = refs.filter(isImage);
	const mapping: Record<string, string> = {};
	images.forEach((ref, index) => {
		const oldIndex = oldImages.indexOf(ref);
		if (oldIndex >= 0 && oldIndex !== index) mapping[`@Image${oldIndex + 1}`] = `@Image${index + 1}`;
	});
	let nextPrompt = remapBodyTags(prompt, mapping);
	const instructions = images.flatMap((ref, index) => ref.rtcFrameRole === "first"
		? [`首帧约束：以 @Image${index + 1} 作为视频开头画面。`]
		: ref.rtcFrameRole === "last" ? [`尾帧约束：以 @Image${index + 1} 作为视频结束画面。`] : []);
	if (instructions.length) nextPrompt += `${nextPrompt ? "\n\n" : ""}${instructions.join("\n")}`;
	return { refs: selected, prompt: nextPrompt, explicitFrames };
}
