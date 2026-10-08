import type { StoryboardShot } from "@/services/projectFile";

/** History may predate the current-result field; preserve order and remove repeated URIs. */
export function episodeStoryboardUris(shot: Pick<StoryboardShot, "storyboardUri" | "storyboardImages">): string[] {
	return [...new Set([shot.storyboardUri, ...(shot.storyboardImages ?? [])].filter((uri): uri is string => !!uri))];
}

/** The row edits the shot's request duration, without changing any existing timeline clip. */
export function episodeShotDurationPatch(shot: StoryboardShot, draft: string): Partial<StoryboardShot> | null {
	const duration = draft.trim() ? Number(draft) : undefined;
	if (duration !== undefined && (!Number.isFinite(duration) || duration <= 0)) return null;
	return { durationSec: duration, overrides: { ...shot.overrides, duration } };
}

/** Freeze this click's targets, and stop preparing additional paid requests once its owner is gone. */
export async function submitEpisodeShotBatch(
	shotIds: readonly string[],
	canContinue: () => boolean,
	submit: (shotId: string) => Promise<boolean>,
): Promise<{ accepted: number; stopped: boolean }> {
	const targets = [...shotIds];
	let accepted = 0;
	for (const id of targets) {
		if (!canContinue()) return { accepted, stopped: true };
		if (await submit(id)) accepted++;
	}
	return { accepted, stopped: !canContinue() };
}
