import type { RtcSegment } from "@/types/rtc";

export type RtcGenerationDuration = NonNullable<RtcSegment["generationDuration"]>;

/** Explicit choices stay exact; Auto fits the current timeline duration to the model catalog. */
export function resolveRtcGenerationDuration(
	choice: RtcGenerationDuration | undefined,
	targetDurationUs: number | undefined,
	durations: readonly number[],
	legacyDuration: number,
): number {
	if (choice !== "auto") return choice ?? legacyDuration;
	const seconds = Math.max(1, Math.ceil((Number.isFinite(targetDurationUs) ? targetDurationUs! : 0) / 1_000_000));
	const available = [...new Set(durations.filter(value => Number.isFinite(value) && value > 0))].sort((a, b) => a - b);
	return available.find(value => value >= seconds) ?? available[available.length - 1] ?? seconds;
}
