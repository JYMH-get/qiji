# RTC generation audit — 2026-10-04

Scope: read-only audit of current dirty working tree. No product/source/existing-test changes, real account data, upstream calls, fees, or deployment. The reproduction files below mock stores/network boundaries and execute actual action/reconciliation modules. Their assertions confirm existing defective behavior; passing is reproduction evidence, not a product regression fix.

Command: `npx vitest run --config outputs/rtc-generation-audit-20261004/vitest.config.ts`
Observed: 2 files, 6 reproduction assertions passed (2026-10-04 17:33 +08).

## Confirmed findings

1. P1 — Project switching during material preparation submits the prior project's shot into the current project.
   - src/rtc/panel/shotGenActions.ts:105, 114; 162, 170, 192.
   - No owner is captured before awaits or validated before startShotGeneration; generationQueue.ts:358-379 creates pending in the current store and claimRun captures its current owner.
   - Reproduction: call video/storyboard generation for A; hold ensurePublicUrl; switch mocked project to B; release upload. Both actual actions submit A prompt + A episode/shot IDs with owner B. If B is copied from A, matching IDs permit incorrect result association; if IDs do not match, paid task has no correct shot/placeholder target.
   - Fix direction: capture original project instance and target at click time, prevent submission after ownership/target changes, preserve prepared uploads using the originating context.

2. P1 — Restored jobs in an inactive episode complete in history but never fill their timeline placeholder.
   - src/rtc/panel/placeholderSwap.ts:214-235 only scans current rtcStore.doc.
   - src/services/generationQueue.ts:456-480 resumes all project pending jobs; :258-264 writes shot history then removes pending.
   - Reproduction: reopen project on episode B, with running placeholder/job in episode A. A result completes while B is active. No watch was armed for A. Open A: placeholder becomes failed with '结果没能自动落位' despite a completed video in A history.
   - Fix direction: restore/watch every RTC episode, and retain task-specific result delivery metadata until the corresponding timeline target is durably filled. Avoid relying only on a temporary watcher and last history item.

3. P1 — Repeat click while preparing material creates duplicate generation requests.
   - src/rtc/panel/RtcShotAiWorkbench.tsx:186-187, 332-341 disables only after pendingGens exists.
   - src/rtc/panel/shotGenActions.ts:134-192 does not lock before await; pending is created after URL preparation.
   - Reproduction: invoke actual genShotVideo twice with same episode/shot/swapSegId while ensurePublicUrl waits; both return true, create two submissions and arm the same placeholder twice. Long uploads make this a normal second-click window, not just a millisecond race.
   - Impact: two potentially charged requests for one intended action; same placeholder retains one active watch, so one result requires manual history recovery.
   - Fix direction: claim per-project/per-target preparation ownership before the first await, show preparing status, release in finally, and keep request identity through result delivery.

4. P2 — Failed storyboard URL preparation silently removes an explicitly requested storyboard.
   - src/rtc/panel/shotGenActions.ts:143 checks only storyboardUri presence; :162 accepts empty conversion result; :200 omits firstFrameUrl.
   - Reproduction: enable genWithStory, disable asset references, existing local storyboard URI, ensurePublicUrl returns empty. genShotVideo returns true and submits without firstFrameUrl and without any alert.
   - Impact: full-reference-capable models may generate without the intended visual anchor and still charge; frame modes may fail later with confusing missing-frame errors.
   - Fix direction: fail early with a visible error if selected storyboard cannot be prepared, as the regular materials loop already does.

## Confirmed code limitation, user-reachable paid loss NOT established

- src/rtc/panel/rtcGenSink.ts:59-82 and 126-137 only search/patch top-level tracks, not subDocs. A synthetic subdocument placeholder cannot be resolved or filled (6th assertion).
- Creating a compound from a running placeholder is explicitly blocked; regeneration from a child media segment currently fails sooner at segActions.tsx root-only liveSeg. Therefore this audit does not claim already-reachable paid child-placeholder loss. Fixing child generation entry points must also update sink and task restoration to traverse child documents.

## Checked and ruled out

- Official material ID preparation is not bypassed just because RTC action files only assemble URLs: managedAdapter.ts:140 calls checkOfficialRequestMaterials, which attaches certified IDs across image/video/audio and first-frame groups.
- Ordinary new image/video placeholders are upgraded to real shots (segShotBinding.ts), so legacy freeGen issues should not be presented as affecting all newly created placeholders.
