---
schema_version: 1
handoff_id: 7d4d
parent_handoff_ids: []
lineage: none
chain: [standalone-67cf]
repo: paseo
workspace: paseo
branch: feat/workspace-identity-accent
head_sha: 388f7f2b707456d396d096ee6488a75fe132147b
created_at: 2026-11-14T03:53:34-05:00
writer: claude-code
---
# Handoff — Herdr overview times, sort and registry prep

The work lives in the repo `~/src/paseo4herdr` (the Herdr plugin), not in `~/src/paseo`. This session's cwd is `~/src/paseo` (branch `feat/workspace-identity-accent`, owned by another session; nothing was changed there).

## The Goal
Herdr overview screen in Paseo: show Herdr workspace, tab and pane names, state, every time fact available (last activity, state changed, session started, estimated prompt-cache-cold), and sort by any field. Then, after djbclark's own test, submit the plugin to the Paseo plugin registry the way "Questions please" was.

## Where We Are
1. Feature built, reviewed (correctness plus four security rounds, all APPROVE), UI-tested on throwaway daemons, merged. `paseo4herdr` `main` = ce9fcc9, pushed to `djbclark/paseo4herdr`. Branch `feat/overview-times-sort` is fully merged (kept on purpose).
2. LIVE: the chain agent 5fd0bef1 fast-forwarded the pasture `~/.cow/pastures/paseo4herdr/paseo4herdr-seam-fixes` (branch `next`) to ce9fcc9 and ran `paseo plugin reload herdr-harness` ("Plugin ready", no errors). The running daemon still loads that pasture path.
3. I changed `~/.paseo/config.json` `plugins.herdr-harness.path` to `/Users/djbclark/src/paseo4herdr/plugin` (deps installed there with `npm ci`; backup of the old file: scratchpad `config.json.before`). `paseo reload` said this path change needs a daemon restart; the daemon was NOT restarted (restart kills all agents; needs djbclark's yes). Both paths hold the same commit.
4. Registry prep is on branch `chore/registry-submission-prep` (597e8f9, pushed to the fork branch only), worktree `/Users/djbclark/src/paseo4herdr-registry-prep`: `plugin/LICENSE`, OVERVIEW "What it reads and sends" and tested-on line, two PNG screenshots in `plugin/assets`, manifest `media`.
5. djbclark has NOT yet reported on his hands-on test of the live screen.

## What We Tried
1. Pointing the live daemon at the new path with `paseo reload`: rejected by the daemon (path changes need a restart); worked around by the chain agent's fast-forward plus `paseo plugin reload`.
2. `bg` refused the `npm ci` in `~/src/paseo4herdr` until a CI decision was recorded (`load-watch ci decide ... local`, runtime deps, no CI route).
3. The worker's commit helper (`git-commit-own`) pushed branches to the fork every time despite a "do not push" instruction; djbclark ruled to keep them.

## Key Decisions
Prose is in the indexed list below. Design came from an Opus design agent (spec: `/Users/djbclark/.local/state/agent-reports/76fb089f-ee3c-4234-b0eb-b06fc1f21e88/ui-ux-design-for-herdr-screen-report.md`).

## Decisions
- [decision] Sort choice persists as a host-scoped plugin setting (`herdr-overview-view`); rejected: per-device storage; because the plugin SDK has no per-device store.
- [decision] Cache-cold estimate shown only for models with the `anthropic/` prefix and always labelled est., TTL assumed 5 minutes; rejected: guessing for other providers; because a wrong cold time misleads.
- [decision] State-change times read "≥ N" after a plugin start; rejected: inventing a time; because Herdr's agent list has no timestamps.
- [decision] Transcript reads are bounded (4 MiB per read, 1 MiB window, 4 files at once, 32 pending), confined to the owning harness's session dir, opened once with handle checks; rejected: unbounded incremental reads; because the first security review blocked on memory use and path abuse.
- [ruling] "1. Merge to main, then point live at a clean main checkout" (djbclark, 2026-11-13).
- [ruling] "1. Throwaway daemon + screenshots" for testing (djbclark, 2026-11-13).
- [ruling] "1. Keep it" for the pushed fork branch `feat/overview-times-sort` (djbclark, 2026-11-13).
- [ruling] "1. Prepare the draft now, send nothing" for the Paseo Cafe/registry submission (djbclark, 2026-11-14).
- [ruling] "1. Keep for now" for the merged worktree `/Users/djbclark/src/paseo4herdr-overview-times-sort` (djbclark, 2026-11-14).
- [ruling] "1. Yes, prep on a branch" for registry assets (djbclark, 2026-11-14).

## Relations
- decided_in [[HANDOFF_standalone-67cf_herdr-overview-times-sort_2026-11-14_7d4d]]

## Evidence & Data
1. Worker reports: `/Users/djbclark/.local/state/agent-reports/76fb089f-ee3c-4234-b0eb-b06fc1f21e88/` (`implement-herdr-screen-changes`, `correctness-review-of-herdr-diff`, `security-review-of-herdr-diff`, `re-review-security-fixes`, `security-re-check-of-latest-fixes`, `final-security-re-check-814320f`, `throwaway-daemon-ui-test` with Retest sections, `investigate-uniprops-dom-warning`, `draft-paseo-cafe-submission`, `prepare-cafe-submission-assets`).
2. Tests: 10 targeted vitest files, 193 tests pass, typecheck passes at ce9fcc9. No full suite and no CI run (plugin repo, local decision recorded).
3. Registry draft: `/private/tmp/claude-502/-Users-djbclark-src-paseo/76fb089f-ee3c-4234-b0eb-b06fc1f21e88/scratchpad/cafe-draft/{steps,listing,gaps}.md`. paseo.cafe is closed to new submissions; the route is the registry form in `getpaseo/plugins` (Questions please was issue 1648; about 25 minutes to publish).
4. `uniProps` red toast on `feat/workspace-identity-accent` is already fixed upstream (getpaseo/paseo issue 7834, PR 7915, commit e958540b0); the branch predates it. Not mine to rebase.

## Operator Feedback
Wants the plugin submitted to the registry, via the same route as Questions please, only after it passes his and my tests.

## Where We're Going
1. THE NEXT ACTION: ask djbclark for the result of his hands-on test of the live Herdr screen (it is live now). Fix whatever he reports on a fresh worktree of `~/src/paseo4herdr`.
2. Resolve the dependency/build-step question (zod runtime; likely move host libs to devDependencies and add `npm ci --omit=dev --ignore-scripts` before the companion build) by installing from the pinned ref on a throwaway daemon; confirm the Paseo version floor (manifest 0.11.1 vs devDependencies 0.11.2).
3. Optionally retake the screenshots with the OMP companion installed before the fake panes start (they currently show Idle and "Read-only" rows).
4. With djbclark's yes: merge `chore/registry-submission-prep` to `main`, tag `v0.1.0-alpha.2`, then file the registry submission (slug `herdr` or `herdr-harness`; mention `omercnet/omp`). Ask before each outward step.
5. Switch the live daemon to the `~/src/paseo4herdr/plugin` path only at a restart djbclark approves; until then the pasture path stays and holds the same commit.
6. Offer to remove worktree `/Users/djbclark/src/paseo4herdr-overview-times-sort` once everything is settled.

## Detached jobs
none (no job records; all sub-agents finished; ports 18806 and 18807 are free).

## Quick Start
1. `git -C /Users/djbclark/src/paseo4herdr log --oneline -3` (expect ce9fcc9 on main).
2. `git -C /Users/djbclark/src/paseo4herdr-registry-prep log --oneline -2` (expect 597e8f9).
3. `paseo plugin ls --json` and look at `herdr-harness`: status running, path the pasture.
4. Throwaway daemon setup for tests: scripts and notes under `/private/tmp/claude-502/-Users-djbclark-src-paseo/76fb089f-ee3c-4234-b0eb-b06fc1f21e88/scratchpad/` (herdr-proxy.py, gen.py, *.mjs); ports 18806/18807 are the registered dev rows; never touch the daemon on 6767 or restart it without a yes.
