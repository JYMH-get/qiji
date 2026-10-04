import { useSyncExternalStore } from "react";
import { getJobProgress, subscribeJobProgress } from "@/services/generationQueue";
import { progressLabel } from "@/lib/queueLabel";

/** Object snapshots stay stable until this specific task's progress changes. */
export function JobProgressText({ taskId, busyLabel }: { taskId: string; busyLabel?: string }) {
    const progress = useSyncExternalStore(subscribeJobProgress,
        () => getJobProgress(taskId), () => undefined);
    if (busyLabel) {
        const queue = progress?.extra?.queuePosition;
        return <>{queue ? `${busyLabel}·排队第${queue}` : `${busyLabel}…`}</>;
    }
    return <>{progressLabel(progress?.progress ?? null, progress?.extra)}</>;
}
