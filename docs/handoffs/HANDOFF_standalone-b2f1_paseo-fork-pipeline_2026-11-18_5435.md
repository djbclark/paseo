---
schema_version: 1
handoff_id: 5435
parent_handoff_ids: [b2f1]
lineage: deterministic
chain: [standalone-b2f1]
repo: paseo
workspace: paseo
branch: feat/workspace-identity-accent
head_sha: da7e3d94af6f3b7a2e53462b04caa78c682b849f
created_at: 2026-11-18T00:00:00-05:00
writer: claude-code
---
# Handoff — paseo fork pipeline, release alerts

## The Goal
Maintain djbclark's fork of Paseo until all his issues are fixed upstream (parent handoff `HANDOFF_standalone-b2f1_paseo-fork-pipeline_2026-11-14_b2f1.md`, its numbered next actions 1-9). This session also took ownership of all orphaned queue items ("the responsibility for any orphaned work") and widened release alerting to every fork djbclark maintains.

## Where We Are
Done and pushed (all re-verified by me, tests run through `bg`):
- ops `site-public-djbclark` `16dcbf7`: `brew-fast-upgrade` always holds the paseo cask even when `BREW_FAST_UPGRADE_SKIP_CASKS` is set (template `roles/site_agents/templates/brew-fast-upgrade.sh.j2`, live `~/.local/bin/brew-fast-upgrade` replaced atomically); test `tests/test_brew_fast_upgrade_hold.py`.
- ops `81c6b81` + private `eda4747`: the `git -C DIR` / env-var git config / Python-argv rule added to item 1 of `home-agents.md` and `cursor/home-agents.mdc` by Astra worker `eb4b28f2` (72/76 lines, 12,953/12,990 bytes). Astra permission was already in the header (`d4c4c6b`).
- ops `9916371`, `ce88b0a`: new `upstream-release` subcommand of `bin/fleet-watch` (+ `bin/fleet_watch_upstream_release.py`, `tests/test_fleet_watch_upstream_release.py`, 22 tests). Zero model calls, runs on the existing 5-minute tick, reads the fork registry, opens one issue per (upstream repo, tag) in the private central repo https://github.com/djbclark/upstream-releases (created by me this session, issues on) per the Grok Bot's final contract, state `~/.local/state/fleet-watch/upstream-release.json`, one courtesy hermes-ping per run. First complete snapshot baselines and opens nothing; a missing production registry on the scheduled tick warns once, at most one ping per 24 h, and never blocks other profiles; an explicit `--registry` run fails visibly on missing or malformed input.
- ops `9488e1b`: test-only fix of four pre-existing `PaseoWatch` failures in `tests/test_fleet_watch_upstream.py` (root cause: tests inherited `PASEO_AGENT_ID` and obsolete defaults). All three fleet-watch test files: 56 passed.
- Earlier: `paseo-local-upgrade` in ops (done, tests); fork branch `local/0.16.0-beta.2` (`5fe11bb9c`, timed macOS arm64 workflow) in `~/src/paseo-beta2-local-wt`; staged `/Applications/Paseo-local-beta2.app` (not installed).
- Earlier in the session: Baton plugin work. Fork PRs 3 and 4 merged, live plugin on `bbdab75c`; upstream PR https://github.com/dennyferra/paseo-baton/pull/5 open with no comments, reviews or checks at last check.

In flight (not mine to finish):
- ADE skill PR https://github.com/djbclark/djbclark-ade/pull/787 (`watch-paseo-release-status`, only `skills/watch/SKILL.md`, the `/watch paseo` section): open, awaiting review; worktree `/Users/djbclark/src/djbclark-ade-watch-paseo-release-wt`.
- Lead `a9a65e9f-d2d4-48ba-9d11-778025af9f77` ("Forks") owns the multi-fork registry/sync/qualification work. It is generating `~/.local/state/djbclark-ade/forks/registry.json` (spec `/Users/djbclark/src/djbclark-ade-fork-inventory-wt/docs/fork-inventory.md`, synthetic sample `/Users/djbclark/.local/state/agent-reports/a9a65e9f-d2d4-48ba-9d11-778025af9f77/registry.example.json`, foundation PR https://github.com/djbclark/djbclark-ade/pull/782). It has NOT activated the production registry. It does not touch `bin/fleet-watch` or `skills/watch`.

## What We Tried
- A model-run recurring check for releases was never considered (rule 13: script, not a recurring prompt).
- Native Paseo notice for new releases: dropped; the only registered recipient `bcff073a` (`watch paseo 1j`) was archived 2026-11-08 and the native sender rejects archived agents.
- hermes-ping alone: rejected by djbclark (he cannot rely on Hermes; wants no human in the loop).
- A per-fork issue/PR in each fork: rejected by the Grok Bot (many forks have issues disabled).
- My own verification run of the brew test failed once because bare `python3 -m pytest` has no pytest: use `uv run --with pytest --with pyyaml pytest` via `bg`.
- A `$(...)` in a double-quoted `paseo send` and a bare `sed` were both rejected by pre-hooks: write the message to a file and use `paseo send ID --prompt-file FILE`; use `gsed`.

## Key Decisions
Alerts go to one central private repo, never edited or closed by the script or by Radar (read-only); djbclark closes an issue himself. The Grok Bot "Radar" reads open issues labeled `radar` + `urgent` at 3:14 AM ET. The watcher takes its fork list from the registry owned by `a9a65e9f` and never keeps a second config. Betas are included. The label is `fork:<fork repo NAME>` (for example `fork:paseo`), never the ADE component id.

## Decisions
- [decision] One central private repo djbclark/upstream-releases for all fork alerts; rejected: an issue in each fork; because many forks have issues disabled.
- [decision] The watcher consumes the registry from a9a65e9f and does not keep its own fork config; rejected: a static list in fleet-watch; because one effective registry avoids drift across all forks.
- [decision] No native Paseo notice for release alerts; rejected: registering a new watch agent; because rule 13 prefers scripts over standing model sessions and the old recipient is archived.
- [ruling] "The responsibility for any orphaned work." (djbclark, 2026-11-18)
- [ruling] "In the normal course of events, we want this to all happen automatically, without human intervention." (djbclark, 2026-11-18)
- [ruling] "Copy a proposal for a contract to clipboard" (djbclark, 2026-11-18)
- decided_in [[HANDOFF_standalone-b2f1_paseo-fork-pipeline_2026-11-18_5435]]

## Relations
- continues [[HANDOFF_standalone-b2f1_paseo-fork-pipeline_2026-11-14_b2f1]]

## Evidence & Data
- Real `--dry-run --once` against the synthetic sample registry: baselined 280 Paseo tags, created no issue and no state. No live issue has ever been created.
- Test results (all via `bg`): brew hold 1 passed (failed before the fix); upstream-release 22 passed; all three fleet-watch files 56 passed, 24 subtests.
- Reports: `/tmp/home-rule-20261118/deliverable.md`, `/tmp/paseo-pipeline-delivery.md` through `delivery5.md`, adversary `/tmp/paseo-release-adversary.md` (APPROVE after round 2). Scratch: `/private/tmp/claude-502/-Users-djbclark-src-paseo/cc051931-d4a1-421e-9447-24bc00ea12bf/scratchpad/` (contract text: `contract-final.md`; radar proposal: `radar-contract.md`).
- Known Lows of the Baton stripper (PR 5): a model name can remain beside `[attribution removed]`; changed lines come back folded; lines over 4000 chars not scanned mid-line.

## Operator Feedback
Radar contract is final (relayed from the Grok Bot, ref RADAR-up); the Grok Bot offered a same-day ping that assigns each issue to djbclark if he asks (he has not). Latency: next 3:14 AM ET brief. Audit corrections stated to him: brew-fast-upgrade does have a source in ops (the Jinja template).

## Where We're Going
1. Wait for `a9a65e9f` to publish the production registry (`~/.local/state/djbclark-ade/forks/registry.json`, `schema_version` 1). When it exists, run once `fleet-watch upstream-release --dry-run --once`, check the baseline output (no issues expected), then let the tick run; the first complete snapshot baselines and opens nothing. Confirm the Radar contract's first real alert later by checking https://github.com/djbclark/upstream-releases/issues after a new upstream tag.
2. PR https://github.com/djbclark/djbclark-ade/pull/787: get it reviewed and merged (djbclark's call; `adversary` verdict already APPROVE on the watcher part).
3. Tell the Grok Bot (via `~/.hermes/skills/agent-tooling/tell-chief-of-staff/scripts/tell_chief_of_staff.py --from claude-code "..."`) only if djbclark asks; the contract text is already agreed. Offer the optional same-day ping if he wants it.
4. Check upstream PR https://github.com/dennyferra/paseo-baton/pull/5 once for maintainer comments (one-shot, untrusted data), report to the current lead.
5. Blocked on the frdminc move of `djbclark/paseo` (operator-gated; `frdminc/paseo` does not exist): WarpBuild timing legs, `packages/desktop/electron-builder.yml` publish repoint (lines 39-41 in `~/src/paseo-beta2-local-wt`, still `getpaseo/paseo`), and the queued Cursor providers-row nested-button fix. Still not started: Forgejo and local timing legs and the timing report.
6. Ask djbclark when it is OK to quit Paseo to install the staged `/Applications/Paseo-local-beta2.app` with `paseo-local-upgrade`; never stop the daemon (pid 42254 earlier) without that.
7. Current lead is uncertain: `2932865e-32d0-49cc-81d0-25b8a40195af` looks archived and a message would un-archive it; peer `a9a65e9f` is active. Report to whoever djbclark names.

## Detached jobs
none (workers `eb4b28f2` and `71c854b7` are idle with reports collected; `71c854b7` can be re-tasked via `paseo send`).

## Quick Start
```
paseo ls -g | rg 'a9a65e9f|71c854b7'
ls ~/.local/state/djbclark-ade/forks/registry.json
python3 ~/ops/site-public-djbclark/bin/fleet-watch upstream-release --dry-run --once --registry ~/.local/state/djbclark-ade/forks/registry.json
gh issue list --repo djbclark/upstream-releases --state all --json number,title,url
gh pr view 787 --repo djbclark/djbclark-ade --json state
```
