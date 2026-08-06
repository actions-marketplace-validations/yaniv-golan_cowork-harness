# Releasing cowork-harness

## How publishing works

Pushing a `vX.Y.Z` tag triggers the `.github/workflows/release.yml` workflow, which publishes to
npm via **OIDC Trusted Publishing** (no stored token). Do **not** run `npm publish` manually — it
requires an OTP and is not how this repo ships.

## The live scenario suite is best-effort (not a publish gate)

The live scenario suite (the `scenarios` job in `ci.yml`) runs live inference only when
`ANTHROPIC_API_KEY` is available to the runner. Without the key it **soft-skips (green)** on every
event — pushes to `main` included — emitting a loud `⚠️ NOT live-validated` marker in the run summary.
It does **not** block the run and is **not** a publish gate: `release.yml`'s `require-ci-success` still
requires the `ci.yml` run for the tagged commit to be green, but a green run does not by itself prove
the scenarios were validated against a real model.

To actually run the live suite in CI, set the `ANTHROPIC_API_KEY` repo secret. There is no
`SKIP_LIVE_SCENARIOS` override — the suite never hard-fails on a missing key, so there is nothing to
override.

## The preferred three-phase sequence (branch → PR → merge → tag)

CI triggers on pushes to `main`, on pull requests, and via manual `workflow_dispatch`. Pushing a release
branch and opening a PR lets CI prove the exact SHA before anything lands on `main`, keeping the "docs skew" window
(main has ≥X.Y.Z docs but npm still has X.Y-1.Z) as short as possible.

```
Phase 1: git checkout -b release/X.Y.Z
         git push origin release/X.Y.Z
         gh pr create --base main --head release/X.Y.Z --title "release: X.Y.Z"
         # CI runs on the PR. The live scenario stage soft-skips whenever ANTHROPIC_API_KEY is
         #   unavailable — which is the case today; see "best-effort (not a publish gate)" above.
  ↓  CI passes
Phase 2: gh pr merge <number> --merge   (or merge via GitHub UI)
         git checkout main && git pull origin main
         git push origin main            # no-op fast-forward — main already advanced (and CI ran) at merge
Phase 3: git push origin vX.Y.Z         # triggers release workflow → npm publish + GitHub Release
         # closes the skew window
         git push origin --delete release/X.Y.Z   # clean up remote branch
         git branch -d release/X.Y.Z              # clean up local branch
```

**Why branch-first?** The old two-phase sequence (`push main` → `push tag`) opened the skew window
the moment `main` was pushed and kept it open until CI passed. The branch+PR approach keeps `main`
clean until CI is already green — the merge and tag happen in immediate succession, so the window is
seconds wide rather than minutes.

Never push the tag before CI is green for the exact commit you intend to tag. The release workflow
enforces this (`Require ci.yml success for this commit` step), but don't rely on it — tag a green
SHA.

> **Tag the MERGE COMMIT (main HEAD after the merge), never the release-branch head — and here's why.**
> The publish gate (`require-ci-success`) queries `ci.yml` runs with `--event push` for the tagged SHA.
> `ci.yml` only triggers `on: push` for **`main`** (plus `pull_request` / `workflow_dispatch`), so a
> release-branch/PR head has *only* a `pull_request` run — which the `--event push` filter ignores.
> Tagging that SHA makes the gate poll ~30 min and then FAIL. Only the merge commit (produced by
> `gh pr merge`, then `git pull`ed onto `main`) has a push-event `ci.yml` run. This is why Phase 3 tags
> `main` HEAD after the merge — do **not** "optimize" by tagging the branch commit whose PR CI you just
> watched go green.

When you query runs by SHA, use the **full 40-char SHA** (`git rev-parse HEAD`) —
`gh run list --commit <short-sha>` silently returns empty. If you mis-tag: `git push origin
:refs/tags/vX.Y.Z && git tag -d vX.Y.Z`, re-tag on `main` HEAD, re-push, and cancel the misfired
release run. Running `npm run preflight -- --for-tag` right before the tag push mechanically catches
this (it asserts `HEAD == origin/main` and that a push-event `ci.yml` run succeeded for `HEAD`).

> **A merge-commit run can be CANCELLED, not just red.** `ci.yml` sets
> `concurrency: cancel-in-progress: true` on `ci-${{ github.ref }}`, so merging a second PR while the
> first merge's `main` run is still going kills the earlier run. Observed 2026-08-06: merging #104 then
> #105 two minutes apart left `c2f2688` with `conclusion: cancelled` and only `75b3b6c` green. The publish
> gate requires `conclusion == success` for the *tagged* SHA, so tagging that earlier commit would poll
> ~30 min and then fail. Tagging `main` HEAD after the last merge (Phase 3 above) avoids this by
> construction — this is a second, independent reason for that rule. Note `ci.yml` grew an arm64 image
> build in `ee0b21f`, which widens the window.

## The `main` ruleset, and the one drift it can hide

A branch ruleset lives in GitHub settings, not in the repo, so nothing here can catch it drifting.
Renaming a CI job orphans any required-check context pinned to the old name, and a required check that no
job reports **never resolves** — every PR stays `BLOCKED` no matter how green CI is. That happened once:
`0ead103` renamed the python job on 2026-07-08 and the ruleset kept the old name for 676 commits.

`npm run preflight` now warns when a required context matches no job. It is WARN-only and SKIPs without
`gh`/admin scope, so it never blocks a release on a read it could not perform.

**Merge expectations, by who is opening the PR:**

- **Non-admin PR** — requires an approving code-owner review. Working as intended.
- **Admin's own PR** — cannot be self-approved (GitHub forbids it), so it merges through the admin-role
  bypass on the ruleset. If a plain `gh pr merge <n> --merge` is refused, use
  `gh pr merge <n> --merge --admin`. The bypass is keyed on the **admin role**, not on any username, so it
  survives adding or changing admins.

## Versioning (semver)

As of `1.0.0`, semver is enforced against the **covered surfaces enumerated in
[SPEC.md §12](./SPEC.md#12-versioning--the-10-compatibility-contract)** (CLI + exit codes, the
scenario/session/baseline/run-result/cassette/protocol schemas, the documented env vars, and the
packaged Action's inputs/outputs): a backwards-incompatible change to a covered surface is a
**major**; a new command/flag or other additive change is a **minor**; a backwards-compatible bug
fix is a **patch**. Human-readable text output is explicitly NOT covered.

**Surface drift is partly automated.** `test/surface-contract.test.ts` snapshots the *structured*
surfaces — every `schema/*.json` (field paths + enums, including exit-code enums), `action.yml`
inputs/outputs, and the documented `COWORK_*` env-var set — into `test/fixtures/surface-baseline.json`.
Any change to those reds CI until you regenerate (`npm run gen:surface`) and review the diff; at `1.0.0`
a *removal or type/enum change* means a **major** bump. `npm run check:surface` prints the
added/removed/changed breakdown.

**1.0.0 surface-freeze review (one-time, MANUAL — the surfaces the snapshot can't cover).** Before
tagging `1.0.0`, deliberately review and freeze the surfaces with no machine-readable source:
- **CLI command + flag surface** — walk `cowork-harness --help` per command; confirm no command/flag is
  removed or repurposed vs `0.x` intent. (No structured source exists — `cli-structural-guard`'s `CASES`
  and `cli-help`'s pinned strings are hand-maintained.)
- **Per-command exit-code semantics** (SPEC §11) — confirm the documented meanings are the ones you
  intend to hold stable.
- **The `PlatformBaseline` shape** (Zod in `src/types.ts`; no `schema/*.json`).

## Version locations — bump ALL of these to the same `X.Y.Z`

> **`npm run bump -- X.Y.Z --write` automates this whole section** (targeted patterns + lockfile +
> `check:versions`). The list below documents *what it touches* — keep it accurate if you add a new
> version-bearing string, and add that string to `scripts/bump-version.ts` too.

1. `package.json` → `"version"` (then run `npm install` to update `package-lock.json`).
2. `.claude-plugin/marketplace.json` → `plugins[0].version`.
3. `.claude/skills/cowork-harness/.claude-plugin/plugin.json` → `"version"`.
4. `.claude/skills/cowork-harness/SKILL.md` → frontmatter `version:`, the `tracks-harness:` line,
   the "**Version note**" block, and the **version floor** in §0 (`needs ≥ X.Y.Z`,
   `npx "cowork-harness@>=X.Y.Z"`).
5. `.claude/skills/cowork-harness/references/scenario-schema.md` → the
   "Tracks `cowork-harness X.Y.Z`" line.
6. `.claude/skills/cowork-harness/references/fidelity-and-answers.md`,
   `.claude/skills/cowork-harness/references/task-recipes.md` and
   `.claude/skills/cowork-harness/references/critique.md` → the
   "Tracks `cowork-harness X.Y.Z`" line in each.
7. The baseline these track (`tracks-harness … (baseline desktop-<ver>)`) — keep in sync with the
   newest `baselines/desktop-*.json`. The `check:versions` guard enforces this for SKILL.md, every
   `references/*.md` baseline pin, and DESIGN.md's current-state sentence — a lagging pin reds CI.
8. `.claude/skills/cowork-harness/references/ci-recipe.md` → all `npm i -g "cowork-harness@>=X.Y.Z"` floors
   (currently 3 occurrences).
9. `examples/replays/README.md` → the `npm i -g "cowork-harness@>=X.Y.Z"` floor.
10. `README.md` → every `cowork-harness@>=X.Y.Z` floor (the bootstrap-fallback `npx`/`npm i -g` lines
    plus the Action-inputs "companion skill's floor guidance" mention). The `check:versions` lockstep
    guard enforces these match the SKILL.md floor and will red CI otherwise.

## Checklist

- [ ] Decide the version per the semver rule above.
- [ ] **Does this release add or change a user-facing CLI flag, assertion key, cassette field, message,
      top-level scenario key, or version coupling?** If so update **CHANGELOG.md + README.md +
      `.claude/skills/cowork-harness/SKILL.md` + `references/`** — a version bump is NOT documentation.
      Only *some* of this is guarded (the assertion-key catalog and cassette schema fields, by
      `test/skill-docs-sync.test.ts`); a new **flag** or **message** is guarded by nothing and is on you.
      Two consecutive consumer adoption reports spent ~40% of their findings on exactly this.
- [ ] **New top-level scenario key?** Then the docs above MUST also state **the version floor and what an
      older CLI does with the key** — the loader is `z.strictObject`, so an unknown key is a hard error
      (`Unrecognized key: "<k>"`, exit 2), never a silent fallback to the default. Adopting the key is a
      floor bump for every consumer, and "it just means the default on older versions" is the wrong guess
      a reader makes when you don't say. This category was added after `lane:` (1.14.0) cleared every
      machine-enumerable guard — schema, `lint`'s valid-key list, the surface snapshot — and still shipped
      with no floor documented anywhere, which cost a consumer a wrong conclusion and a wasted test cycle.
- [ ] **CHANGELOG.md** — move everything under `## [Unreleased]` into a new
      `## [X.Y.Z] — YYYY-MM-DD` section; leave an empty `## [Unreleased]` on top. Include any
      **upgrade notes** (e.g. "re-record cassettes after the staleness-hash change").
- [ ] Bump every version location (items 1–10) with **`npm run bump -- X.Y.Z --write`** — it rewrites all
      of them via targeted patterns and updates the lockfile + self-checks `check:versions` (run without
      `--write` first to preview the diff; dry-run is the default). It deliberately does **not** touch the
      CHANGELOG — do the CHANGELOG move (above) by hand. (It also does not add a SKILL.md
      `- **X.Y.Z:**` release-note bullet, and you should NOT add one: that per-release section was removed
      in 1.10.0 because SKILL.md is loaded into an agent's context on every invocation and the history
      could never change its behaviour. The CHANGELOG is the release record.)
- [ ] `npm run preflight` — local pre-release gate (`check:versions`, CHANGELOG heading present + non-empty,
      tag `vX.Y.Z` not already used, clean tree; warns if the `ANTHROPIC_API_KEY` repo secret is missing so
      the push-to-main live suite will soft-skip and this release won't be live-validated in CI; warns if a
      ruleset **required status check** names no job in `ci.yml`).
- [ ] `npm run format:check` — fix any issues (`npm run format:write`).
      A format failure is the most common first-pass CI red.
- [ ] `npx tsc -p tsconfig.test.json --noEmit` — typecheck including tests.
- [ ] `npm run ci` (typecheck + build + test) is green locally.
- [ ] `npm pack --dry-run` — confirm the tarball contains `dist/`, `baselines/`, `docker/`, the bundled
      `scenario.py` + `assertion-keys.json` (the skill itself ships via the marketplace, not npm), and no
      internal planning notes.
- [ ] Public export resolves: `node --input-type=module -e "import('cowork-harness/secrets').then(m => {
      if (!m.scrubField || !m.collectSecrets) throw new Error('missing export'); })"` (run from an install of
      the packed tarball, or via self-reference in-repo). Guards the sole programmatic API subpath.
- [ ] Commit everything (`chore: bump to X.Y.Z; sync docs, CHANGELOG, and skill`).
- [ ] **Phase 1 — branch + PR**:
      ```
      git checkout -b release/X.Y.Z
      git push origin release/X.Y.Z
      gh pr create --base main --head release/X.Y.Z --title "release: X.Y.Z"
      gh run watch $(gh run list --branch release/X.Y.Z --limit 1 --json databaseId --jq '.[0].databaseId')
      ```
- [ ] **Wait for CI green** on the PR. Fix any failures on the branch and push again; CI re-runs
      automatically.
- [ ] **Phase 2 — merge**:
      ```
      gh pr merge <number> --merge
      git checkout main && git pull origin main
      git push origin main
      ```
- [ ] **Phase 3 — tag and publish** (tag the MERGE COMMIT = current `main` HEAD, per the "why" above):
      ```
      git checkout main && git pull origin main
      npm run preflight -- --for-tag   # asserts HEAD==origin/main AND a green push-event ci.yml run for HEAD
      git tag vX.Y.Z                   # on main HEAD (the merge commit)
      git push origin vX.Y.Z
      gh run watch $(gh run list --workflow=release.yml --limit 1 --json databaseId --jq '.[0].databaseId')
      ```
- [ ] **Clean up**: `git push origin --delete release/X.Y.Z && git branch -d release/X.Y.Z`
- [ ] **Move the major/minor tags** (so `uses: yaniv-golan/cowork-harness@v1` and `@v1.0` resolve to
      this release — the packaged Action's Marketplace consumers pin those):
      ```
      git tag -f vX vX.Y.Z && git tag -f vX.Y vX.Y.Z   # e.g. v1 and v1.0 → v1.2.3
      git push -f origin vX vX.Y
      ```
      (Force-moving these ALIAS tags is expected; never force-move the immutable `vX.Y.Z` release tag.
      As of 1.0.4 the alias tags do NOT trigger `release.yml` / `publish-image.yml` — their `on.push.tags`
      globs match full `vX.Y.Z` semver only — so pushing them produces no workflow runs at all.)
- [ ] Smoke the published artifact: `npx cowork-harness@X.Y.Z --version` and
      `npx cowork-harness@X.Y.Z doctor --tier protocol`.

## Notes

- "Merge is not push." Local merges/commits never imply a release — the steps above are the only
  ones that make anything public; run them only on an explicit decision to release.
- Planning notes belong in a gitignored location excluded from the npm tarball; never commit or publish them.
- If the tag was placed on the wrong commit (e.g. a follow-up fix was needed), delete the local tag
  (`git tag -d vX.Y.Z`), re-create it on the correct commit, and push it.
- The live `scenario suite` CI stage is skipped on **fork** PRs and, independently, soft-skips whenever
  `ANTHROPIC_API_KEY` is unset — logging `ANTHROPIC_API_KEY not set — skipping live scenario suite` and
  exiting 0. **Observed 2026-08-06 on PR #104/#105: the key was not available and the suite skipped** —
  the job log carries `##[warning]ANTHROPIC_API_KEY not set`, which is the authoritative evidence
  (`gh secret list` is also empty, but it sees only repo-level Actions secrets, so absence there alone
  would not prove it). A green check on that job is therefore NOT evidence of live validation —
  `ci.yml` prints that warning in the job summary itself, and `npm run preflight` raises its own
  `live-suite key reminder` WARN for the same reason.
  Re-read this bullet if a key is ever added; the `build` + `test` + `image-recipe` + `boundary` stages
  are what actually gate a release today.
