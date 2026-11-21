---
schema_version: 1
handoff_id: 403c
parent_handoff_ids: [5435]
lineage: inferred
chain: [standalone-b2f1]
repo: paseo
workspace: paseo
branch: feat/workspace-identity-accent
head_sha: 2153ec3f77fba7b146993580d82f75ad0dfb219c
created_at: 2026-11-21T19:30:00-05:00
writer: claude-code
---
# Handoff — Paseo install hold, Android fork keystore, WarpBuild, frdminc move follow-ups

Lead agent id `4c3521b9-65c8-4fba-be7f-d44cae5c1d3e` (Claude session `ed2e91d3-05ff-42c8-8bff-761f093d8c4d`). Parent: `HANDOFF_standalone-b2f1_paseo-fork-pipeline_2026-11-18_5435.md` (this lead's earlier fork-release-alerts work; lineage inferred from that continuation). This handoff records no repo edits of its own: the work lives in other repos, worktrees and the reports directory named below.

## The Goal
Keep djbclark's Paseo fork family current and deployed on OUR merge build (never a vendor release while we carry patches), publish an Android fork build for Obtainium, move the CI heavy lifting to WarpBuild, and finish the follow-ups of the 2026-11-21 move of every `~/src/paseo*` public repo from `djbclark` to `frdminc`.

## Where We Are
- **frdminc org move: DONE and verified (2026-11-21).** Eight repos under `frdminc`: `paseo`, `paseo-plugins-gpambrozio` (was `djbclark/paseo-plugins`), `paseo-plugins-omercnet`, `paseo-session-recovery`, `paseo4herdr`, `paseo-plugin-questions-please`, `paseo-plugin-dann-workspace-accent`, `paseo-baton` (fork). `frdminc/paseo-plugins` (the old fork) was deleted after a bundle backup (`frdminc-paseo-plugins-renovate-omp-sdk.bundle`). All 38 agents coordinated; local remotes rewritten with `bin/rewrite-remotes.py`; MOVED announced. Remaining: owners rewrite `djbclark/paseo*` literals (djbclark-ade lead `c4019464`, about 40 literals; `74e4adbf` paseo4herdr README/docs/plugin package.json; `734e81bd` shift-drag notes).
- **Desktop install: ON HOLD.** Final build is the Antigravity build (branch `local/main-desktop-antigravity-20261121` @ `5e44af1b5`, worktree `~/src/paseo-desktop-antigravity-wt`): scrolling-divider patch + PR 10325 + #10310, #10368, PR 10428 + the 30 s replay-wait cap. Zip `/Users/djbclark/.local/state/agent-reports/4c3521b9-65c8-4fba-be7f-d44cae5c1d3e/antigravity-build-output/Paseo-main-arm64.zip`, SHA-256 `293124d97744d9d0f53265931f7ff6c1a88f4384e417522170aacbf0704aa964`, CDHash `76b32aefb34f7efd6433139c165ea590ee02aa09`. Install drafts (mode 0600, never run) in `.../4c3521b9-.../install-drafts/`: `cutover_steps.py` d962cb4a…98b0, `RUNBOOK.md` fc91b5c7…8c09, `offline-quit-executor-rev3.py` b5f6ad3c…fddf, `test_cutover_steps.py` 94bc22ab…6e57 (62 tests OK). Adversary round 7 follow-up and the cap commit review were CLEAN. djbclark answered "Hold, no time yet" and has not pasted a GO line.
- **Android fork (`sh.paseo.fork`, "Paseo Fork")**: proof build passed (run 44937891428, APK sha256 `1e224c8e…`, ephemeral key, apksigner verified; branch `local/android-fork-20261121` @ `b430d63ca`, worktree `~/src/paseo-android-fork-wt`, report `android-fork-proof.md`). Phase 1 ships without push notifications. Keystore plan drafted: `/Users/djbclark/.local/state/agent-reports/ed2e91d3-05ff-42c8-8bff-761f093d8c4d/android-keystore-plan.md`. djbclark chose "1. Start now: show me each step before I run it".
- **WarpBuild**: djbclark chose "2. Yes: set the API key and run one proof job". Not started. `frdminc` has `warpbuildbot` installed; runner label `warp-macos-26-arm64-6x`.
- **Memory**: `project_android_fork_obtainium_20261121.md`, `project_queued_antigravity_blank_on_handoff_20261121.md`, `project_paseo_family_frdminc_move_20261121.md`, `project_queued_shift_drag_copy_20261121.md`, `project_711c_install_rulings_20261120.md` (all under `/Users/djbclark/.claude/projects/-Users-djbclark-src-paseo/memory/`).
- **Working tree** of `/Users/djbclark/src/paseo` (branch `feat/workspace-identity-accent`, head `2153ec3f7`): `M .gitignore`, `?? .ignore`, two untracked older handoffs. They are not mine: never stage them.
- Tests: no code tests this segment beyond the install-draft suite (62 OK via bgrun) and the Android proof workflow (green on round 3).

## What We Tried
1. Android proof round 1 failed: Gradle autolinking overlay dropped local modules. Fixed in `5ce5e3fa5`.
2. Round 2 failed at the verify step ("unexpected signer count"): the script mis-parsed apksigner output. Fixed in `b430d63ca` by parsing "Number of signers: N". Round 3 passed.
3. A forked `frdminc/paseo-plugins` blocked moving the omercnet fork (an org cannot hold two forks of one network). Resolved by deleting the frdminc one after backup, as djbclark ruled. Deleted forks in a non-empty network are not restorable on the free plan.
4. The `gh` token lacked `delete_repo`: obtained by a device-code refresh djbclark approved. The scope is still on the token on purpose.
5. Install-draft round 7: RUNBOOK ordering defect (adversary M-R) fixed in rev8.
6. Hooks blocked: bare `sed` (use `gsed`), `&` job control (use `run_in_background`), bare `open` (use `open-clean`), piped `$?`, sends to archived agents, and `secret_read_gate.py` on the glob `~/.local/state/bigteam/*/jobs/*.json` (fail-closed glob budget; use per-directory reads).

## Key Decisions
Chosen: only OUR merge build is installed (no vendor update); install needs djbclark's own GO line with a quiet time; Android id `sh.paseo.fork` with GitHub releases for Obtainium, no push in phase 1, one stable release key (PKCS12 RSA 4096, alias `paseo-fork`, 10000 days, created offline on a RAM disk with JDK 21 keytool, escrowed in 1Password "Service" vault, second copy on an AES-encrypted disk image on a USB stick, restore proof gate, CI `android-release` environment with a required reviewer, tag rule `fork-android-v*`, variable `ANDROID_KEY_ALIAS`, `ANDROID_KEYSTORE_CERT_SHA256`); a new `android-fork-release.yml`, never edit upstream's `android-apk-release.yml`. Rejected: vendor 0.17.0-beta.1 as the install target (we carry patches); creating the key in CI; auto-updater route (offline Cmd-Q is the only safe path; electron-updater needs explicit `publish: null`, and `--dir` builds have no `app-update.yml`).

## Decisions
- [decision] Install only our own Antigravity merge build, never a vendor release; rejected: upgrading to upstream 0.17.0-beta.1 as published; because we carry patches against it.
- [decision] Android release key created offline on a RAM disk, escrowed in 1Password Service vault plus an encrypted USB copy; rejected: generating the keystore in CI; because Obtainium needs one stable key and the key must never print or leave djbclark's control.
- [decision] Use a new workflow `android-fork-release.yml` with tag pattern `fork-android-v*`; rejected: editing upstream's `android-apk-release.yml`; because upstream's six tag workflows must not fire.
- [ruling] "go directly to our merge build based on the latest, we don't need to upgrade to any vendor releases unless we have no patches against them" (djbclark, 2026-11-21)
- [ruling] "4. Hold, no time yet" (djbclark, 2026-11-21)
- [ruling] "Please announce to all agents - there are many working on paseo or paseo plugins, give them a chance to get back to you, and coordinate with them, we should be moving all ~/src/paseo* repos from djbclark to frdminc at the same time" (djbclark, 2026-11-21)
- [ruling] "waive the test for now; schedule it for after the move and new paseo install" (djbclark, 2026-11-21)
- [ruling] "1. Start now: show me each step before I run it" (djbclark, 2026-11-21)
- [ruling] "2. Yes: set the API key and run one proof job" (djbclark, 2026-11-21)
- [ruling] "2. Keep it for now" on the temporary `delete_repo` gh scope (djbclark, 2026-11-21)

## Relations
- continues [[HANDOFF_standalone-b2f1_paseo-fork-pipeline_2026-11-18_5435]]
- decided_in [[HANDOFF_standalone-b2f1_paseo-install-android-warpbuild_2026-11-21_403c]]

## Evidence & Data
Reports under `/Users/djbclark/.local/state/agent-reports/`: `4c3521b9-65c8-4fba-be7f-d44cae5c1d3e/` (`report-install-drafts-rev7.md`, `report-install-drafts-rev8.md` with the final GO templates, `antigravity-fixes.md`, `android-fork-proof.md`, `android-fork-scope.md`) and `ed2e91d3-05ff-42c8-8bff-761f093d8c4d/` (`adversary-round-7-rev7-re-verify-report.md`, `adversary-cap-commit-report.md`, `frdminc-paseo-move-plan.md`, `frdminc-paseo-family-move-plan.md`, `frdminc-paseo-plugins-deletion-audit.md`, `android-keystore-plan.md`). Move logs and tools: `~/.local/state/ade/frdminc-move-20261114/` (`LOG-transfer-family-20261121.md`, `LOG-remotes-family.tsv`, `bin/rewrite-remotes.py`, pre-snapshots). Scratch: `/private/tmp/claude-502/-Users-djbclark-src-paseo/ed2e91d3-05ff-42c8-8bff-761f093d8c4d/scratchpad/` (`orgmove-*.md`, `move_window.py`, `verify.py`, `BRIEF-*.md`). Final GO templates (from rev8; union of cutover_steps.py and offline-quit variant):
`GO 711c zip=293124d97744d9d0f53265931f7ff6c1a88f4384e417522170aacbf0704aa964 option=III.3.b-offline executor=d962cb4a699b51cf40c0ce6cf4f0c5d3fbbde27189b9e742649d7d5b28f498b0 runbook=fc91b5c72f3e9c97196ad7231c187ecb5ebcd363c4cef9afb01914a235b98c09 quiet=<YYYY-MM-DD h:mm AM/PM> EST, window <N> min; rollback=0.16.1+snapshot` (offline-quit executor variant: `executor=b5f6ad3cf7b033127407108a2b7a90fa156b2340d1fee72040f612da2fecfddf`, no `runbook=`). Remotes now: `~/src/paseo` origin `frdminc/paseo`; `~/src/paseo-plugins` and `~/src/paseo-plugins-omercnet` origin `frdminc/paseo-plugins-gpambrozio`, omercnet gitdir remote `fork-omercnet`; `paseo-baton` remote `fork` is `frdminc/paseo-baton`, origin stays `dennyferra`.

## Operator Feedback
Install never without his own GO and a quiet time; never quit or restart the Paseo app or daemon without a plan; contact LEADs only and never stop paid work; show exact text before any public posting; secrets only via `sudo-secretspec`, never printed; the Android keystore is never created in CI and never printed; the Shift-drag test is waived until after the move and the install.

## Where We're Going
1. **Start the Android keystore walkthrough with djbclark**, showing each step before he runs it (follow `android-keystore-plan.md`; needs his USB stick, a passphrase he picks, and GitHub settings; CI secrets only after the repo is at frdminc, now true). Dry-run `gh secret set` newline handling and `op read --no-newline` first.
2. **WarpBuild**: load the `sudo-secretspec` skill, set `WARPBUILD_API_KEY`, show the proof workflow text first, then run one proof job on `warp-macos-26-arm64-6x` on `frdminc/paseo`. Outward-facing and billable.
3. **Install**: still needs his quiet time and his own `GO 711c …` line. Before the window re-notify the leads, snapshot all agents at the gate, include the L-O warning (no logout, restart or shutdown while 0.16.1 runs online) in the GO message only, keep rollback copies at least 7 days. Worker `0d2da8c3` is kept for possible draft edits.
4. Remind djbclark to revoke the temporary `delete_repo` gh scope at session end or before unattended work.
5. Shift-drag hands-on test after the move AND the install (owner `734e81bd`; branches `feat/shift-drag-copy` @ `30e0c4bf3` and `ci/shift-drag-copy` @ `e4e2abc63` must survive), then Discussion + PR on his OK.
6. Antigravity blank-screen-on-handoff re-test after the new build is installed; if it persists, dupe-search getpaseo/paseo and file or add to a thread (memory file above).
7. Track the `djbclark/paseo*` literal rewrites by `c4019464`, `74e4adbf`, `734e81bd`. Before the Android workflow merges, remove its branch-pinned push trigger. The first Android release tag text needs his OK before anything is published.
8. Optional: upstream PR watching (PR 9665, issue #10118), `fleet-watch upstream-release` baselines, old worktree cleanup. A daemon restart stays a separate approval.

## Detached jobs
none (the job-record scan was blocked by `secret_read_gate.py` glob budget; the dispatch shim was deleted 2026-11-14 and this session dispatched no job records; its workers were native `paseo run` agents). Nothing here assumes a `run_in_background` task survives.

## Quick Start
```
python3 ~/src/djbclark-ade/bin/claude_identity.py
paseo ls -g --json            # confirm 38 agents, c4019464 / 74e4adbf / 734e81bd status
git -C ~/src/paseo remote -v  # origin should be frdminc/paseo
cat /Users/djbclark/.local/state/agent-reports/ed2e91d3-05ff-42c8-8bff-761f093d8c4d/android-keystore-plan.md
```
