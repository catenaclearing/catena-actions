# PLAT-552: Stop People Approving Their Own Changes Through `catena-machine` Pull Requests (DCF-5)

## Status

**Phase 1 applied on 2026-10-24 at 20:51:40 UTC (13:51:40 PDT) by `kamalgill`, using the API.** Org ruleset `8576896` now
has `require_last_push_approval: true`. Nothing else in the ruleset changed. Evidence is in [`evidence/`](evidence/):

| File | What it shows |
|---|---|
| `ruleset-8576896-before.json` | The ruleset at 20:51:27 UTC, before the change (`require_last_push_approval: false`) |
| `ruleset-8576896-after.json` | The ruleset after the change. Its `rules` differ from the before file in this one flag only |
| `ruleset-8576896-history.json` | GitHub's version history for the ruleset. Version `54627799`, actor `kamalgill` (id 133923), 2026-10-24T13:51:40-07:00 |
| `repo-coverage.txt` | The effective rule on the default branch of all 70 non-archived org repos. Every one reports `true` |
| `pr-185-self-approval-blocked.json` | Negative test (2026-10-24, 20:55–20:58 UTC). [catenaclearing/catena-platform#185](https://github.com/catenaclearing/catena-platform/pull/185) was opened by `catena-machine`. Its only commit is by `kamalgill`, and GitHub's repo activity API records `kamalgill` as the account that pushed it (`last_push`). `kamalgill` approved it. All four required checks passed, yet GitHub reports `reviewDecision: REVIEW_REQUIRED` and `mergeStateStatus: BLOCKED` |

The org audit-log REST API returns 404 on this plan, so the ruleset's version history stands in for the audit-log entry.
The ruleset's **History** tab in the UI shows the same thing.

Kamal captured a screenshot of #185's merge box, which shows the approval requirement. The screenshot isn't stored in this
folder.

Positive test passed: `shanofon` approved #185 at 2026-10-24 21:15:45 UTC, and Kamal confirmed that the approval
enabled the Merge button. #185 was closed unmerged at 21:48:12 UTC.

Still to do: the `telematics-*` repeat (optional; `repo-coverage.txt` already shows the rule applies there), attaching
evidence to Linear, and comms.

**2026-10-27:** Phase 1 stopped the `telematics-api-docs` changelog auto-merge, and a workaround is proposed. While
investigating, we found that `catena-machine` is an org admin. See
[Follow-up: `telematics-api-docs` changelog auto-merge](#follow-up-telematics-api-docs-changelog-auto-merge-2026-10-27)
and [Finding: `catena-machine` is an org admin](#finding-catena-machine-is-an-org-admin-2026-10-27).

## Context

DCF-5 (Change Management Policy) requires every change to be approved by someone other than its author before it merges
to `main`. The DCF-5 observation window opens on **2026-10-31**, and the ticket is due **2026-10-30**.

### How the gap happens

Every service repo has a `.github/workflows/pull-request.yaml` that runs `on: create`. It calls
`catenaclearing/catena-actions/composite/open-pull-request@v0`, and that action runs `gh pr create --draft` with
`MACHINE_USER_PAT`. So as soon as someone pushes a new branch, `catena-machine` opens a draft PR for it, and GitHub
records **`catena-machine` as the PR author**.

GitHub only stops a PR's *author* from approving it. The engineer who wrote the change is not the author, so they can
approve the PR. That approval meets the one-review requirement, and they can merge.

Repos with this workflow: `catena-actions`, `catena-keycloak-service`, `catena-platform`, `catena-utils-package`,
`telematics-data-service`, `telematics-integrations-service`, `telematics-intelligence-service`,
`telematics-notifications-service`, `telematics-organizations-service` and `telematics-usage-service`.

### Evidence that it already happens (checked 2026-10-24)

In `catena-platform`, `catena-machine` authored both PRs below, `RahulNadkarni` wrote every commit, and
`RahulNadkarni` was the only approver:

| PR | Commit authors | Approvers | Merged by |
|---|---|---|---|
| [catenaclearing/catena-platform#181](https://github.com/catenaclearing/catena-platform/pull/181) | RahulNadkarni | RahulNadkarni | RahulNadkarni |
| [catenaclearing/catena-platform#183](https://github.com/catenaclearing/catena-platform/pull/183) | RahulNadkarni | RahulNadkarni | RahulNadkarni |

For comparison, `#175` (kamalgill → scottquested) and `#184` (shanofon → PranavCatena) were reviewed independently.

### Current review controls

The org ruleset **"Enforce require PR review to merge to default branch"** (id `8576896`, `source_type: Organization`)
targets `~DEFAULT_BRANCH`, `refs/heads/main` and `refs/heads/master`. It applies to every repo spot-checked
(`catena-platform`, `catena-actions`, `catena-keycloak-service`, `catena-utils-package`, `catena-dashboard`,
`telematics-data-service`, `telematics-usage-service`). Its `pull_request` rule is:

```json
{
  "required_approving_review_count": 1,
  "dismiss_stale_reviews_on_push": true,
  "require_last_push_approval": false,
  "require_code_owner_review": false,
  "require_extra_approval_for_unattributed_changes": true,
  "required_review_thread_resolution": false,
  "allowed_merge_methods": ["squash"]
}
```

`require_last_push_approval: false` is the gap.

Its bypass actors are `OrganizationAdmin` with `bypass_mode: always`.

`require_extra_approval_for_unattributed_changes` doesn't help here. According to GitHub's docs, it only adds an approval
when **Copilot** opens a PR under its own app identity. It does nothing for a machine user's PAT.

`catena-platform` also has classic branch protection on `main` with `require_last_push_approval: false`. Rulesets and
classic protection add together, and the strictest setting wins, so the ruleset change below is enough. Classic
protection doesn't need to change.

## Decision

**Turn on "Require approval of the most recent reviewable push" (`require_last_push_approval: true`) in org ruleset
`8576896`.**

GitHub describes the setting as follows: "the most recent reviewable push must be approved by someone other than the
person who pushed it." The engineer pushes their own commits to the branch `catena-machine` opened, so they are the last
pusher. Their own approval no longer counts, and the PR stays blocked until another engineer with write access approves.
It doesn't matter who opened the PR. Because the setting lives in an org ruleset, one change covers every repo the
ruleset targets, and no workflow in any repo has to change.

### Alternatives considered

- **Stop `catena-machine` from opening PRs** by removing the `on: create` workflow, so engineers open their own PRs and
  GitHub's author rule applies. This would mean a PR in each of ~10 repos plus a habit change, it would lose the
  automatic draft PR, and it would still leave the "someone else pushed last" gap described below. Rejected as the
  primary control, though the org setting doesn't stop us doing it later.
- **Open the PR as the person.** A workflow triggered by `create` has no token for the person who pushed, so this isn't
  possible.
- **Custom "independent review" status check.** This is stronger, but it means a new workflow to build and maintain.
  It's Phase 2 below, and it's optional.

## Phase 1: org ruleset change (does all of "Done when")

No code change in any repo. An **org owner** has to make the change, because reading and writing org rulesets needs
the `admin:org` scope. The current `gh` token doesn't have it.

### 1. Before the change

1. Export the current ruleset for the before/after evidence:
   ```bash
   gh api orgs/catenaclearing/rulesets/8576896 > ruleset-8576896-before.json
   ```
2. Confirm which repos the ruleset targets (`conditions.repository_name` / `repository_property`). If any repo that
   ships to production is excluded, list it and add it, or open a follow-up ticket.
3. List the open PRs where the approver is also the last pusher. They'll become unmergeable when the setting turns on.
   Post a heads-up in the engineering channel before the change (see Comms).

### 2. Make the change

**UI (preferred, since it leaves a clear audit-log entry):** Org **Settings → Repository → Rulesets → "Enforce require
PR review to merge to default branch" → Require a pull request before merging → ☑ Require approval of the most recent
reviewable push → Save changes.**

**API equivalent.** `PUT` replaces the rule set, so send the full rules array back with only the one flag changed:

```bash
gh api orgs/catenaclearing/rulesets/8576896 \
  | jq '{rules: (.rules | map(if .type == "pull_request"
                                 then .parameters.require_last_push_approval = true
                                 else . end))}' \
  | gh api -X PUT orgs/catenaclearing/rulesets/8576896 --input -
```

Leave everything else as it is, including `dismiss_stale_reviews_on_push`, the bypass actors and the Copilot rules.

### 3. Verify

1. `gh api repos/catenaclearing/catena-platform/rules/branches/main --jq '.[] | select(.type=="pull_request") | .parameters.require_last_push_approval'`
   returns `true`.
2. **Self-approval is blocked (negative test).** Push a throwaway branch (for example `plat-552-verify`) with one trivial
   commit to `catena-platform`. `catena-machine` opens the draft PR. Mark it ready, approve it as yourself, then run
   `gh pr view <n> --json reviewDecision,mergeStateStatus`. The PR must not be mergeable, and the merge box must say an
   approval is needed from someone other than the last pusher. Take a screenshot.
3. **An independent approval still works (positive test).** A second engineer approves, and the PR becomes mergeable.
   Close it unmerged and delete the branch.
4. Repeat step 2 in one `telematics-*` repo to show the org-level coverage.

### 4. Audit evidence for the Linear ticket

- `ruleset-8576896-before.json` and `ruleset-8576896-after.json`, with the date and time of the change.
- The org audit-log entry for the ruleset update (`repository_ruleset.update`, actor and timestamp), or a screenshot of
  the ruleset's **History** tab.
- Screenshots from the negative and positive tests above.
- A link to this plan.

Save copies in `soc2-compliance-evidence` alongside the other DCF evidence.

### 5. Comms

Post a short note in the engineering channel before the change: "From <date>, a PR needs approval from someone who
didn't push its last commit. Approving your own `catena-machine` PR no longer unblocks merge." Also add a line to the
`open-pull-request` README in `catena-actions` (optional; a doc-only PR there).

## Remaining gaps (not closed by Phase 1)

1. **Someone else pushes last.** If reviewer B pushes the last commit to A's PR, including by clicking **Update
   branch**, then A can approve and merge a PR that still contains A's earlier commits. `dismiss_stale_reviews_on_push`
   doesn't change this. It's rarer than the self-approval pattern, but strictly it still breaks "a person can no longer
   approve a PR that carries their own change." Phase 2 closes it.
2. **Org admin bypass (`bypass_mode: always`).** Org owners can merge without any approval. This is tracked under
   SEC-84 (access review of owners and rule bypass) and is out of scope here, but it should be called out to the
   auditor as a compensating-control item.
3. **`catena-machine` PAT scope.** The shared token's blast radius is RISK-023 / SEC-85. Out of scope here. See
   [`catena-machine` is an org admin](#finding-catena-machine-is-an-org-admin-2026-10-27), which makes this gap and gap 2
   one problem.

## Follow-up: `telematics-api-docs` changelog auto-merge (2026-10-27)

### What broke

Phase 1 stopped the unattended changelog merge in `telematics-api-docs`. Its
`.github/workflows/changelog-auto-merge.yaml` (FE-562, FE-898) runs on PRs that `mintlify[bot]` opens:

1. **Push Normalised Entry** commits the published form of the entry to the PR branch through the GitHub API, as
   `catena-machine`. The step is a no-op when the entry is already in published form.
2. **Approve** approves the PR as `catena-machine`.
3. **Enable Auto Merge** runs `gh pr merge --squash --auto`.

When step 1 commits, `catena-machine` becomes the last pusher. Its approval in step 2 then no longer counts, so
auto-merge waits forever. The first PR affected was `telematics-api-docs#683`:

| Time (UTC, 2026-10-27) | Event |
|---|---|
| 16:56:48 | push by `mintlify[bot]` |
| 16:57:15 | push by `catena-machine` (normalised entry) |
| 16:57:28 | `catena-machine` approves. The approval doesn't count |
| 17:05:54 | `scottquested` approves by hand, then merges at 17:06:59 |

### Proposed workaround: a dedicated org ruleset for `telematics-api-docs`

1. Create an org ruleset, for example "Enforce require PR review to merge to default branch (telematics-api-docs)",
   that targets only `telematics-api-docs`. Make it an exact copy of `8576896` except for
   `require_last_push_approval: false`.
2. Add `telematics-api-docs` to `8576896`'s `conditions.repository_name.exclude`.
3. Save the before and after JSON of both rulesets in `evidence/`, the same way as Phase 1. Then check that the next
   Mintlify changelog PR merges unattended.

Everything except last-push approval stays in force for the repo: dismiss stale approvals, required signatures,
squash-only merging and the org-admin-only bypass. Auto-merge works again because `catena-machine` approves *after*
its own push, so dismiss-stale doesn't remove that approval.

**Trade-off.** People in this repo lose the last-push rule as well, not only the bot. The cost is small, because
`telematics-api-docs` has no `on: create` workflow. `catena-machine` doesn't open PRs for people there: engineers open
their own PRs, and GitHub already stops a PR's author from approving it. What's left is the narrow case where someone
else pushes last and the author then approves (gap 1). The changelog auto-merge itself is a documented automation
exception (FE-562): a bot approves bot-written, additive docs, not a person approving their own change. Tell
Compliance about it.

### Alternatives considered

- **Exclude the repo and rely on its own `main-protection` ruleset (`3043537`).** This was the first idea. That ruleset
  is weaker than the org ruleset in more ways than last-push approval. It has `dismiss_stale_reviews_on_push: false`,
  so someone can get an approval, push more commits and merge on the old approval. That's a wider DCF-5 hole than
  last-push. It has no `required_signatures` rule, which undoes the reason FE-697 commits through the API. It allows
  merge and rebase as well as squash. It also lets the repo's admin role and `catena-machine` bypass it, and repo admins
  can edit it, which they can't do to an org ruleset. If this route is chosen anyway, add dismiss-stale, required
  signatures and squash-only merging to `main-protection` in the same change.
- **Approve as `github-actions[bot]` instead.** This needs "Allow GitHub Actions to create and approve pull requests".
  A `pull_request` workflow runs the PR branch's own copy of the workflow file, so any branch could then approve
  itself. Rejected.
- **Merge with `gh pr merge --squash --admin` (bypass).** This works today only because `catena-machine` is an org
  admin (see the finding below). It would build on access that should be removed. Rejected.

## Finding: `catena-machine` is an org admin (2026-10-27)

`gh api orgs/catenaclearing/memberships/catena-machine` returns `role: admin`. Ruleset `8576896` lets
`OrganizationAdmin` bypass it with `bypass_mode: always`, so `catena-machine` can merge or push to `main` in any repo
without review.

- **It's already in use.** `telematics-api-docs`'s **Scheduled TSP Rebuild** commits `chore: auto-regenerate TSP
  pages` straight to `main` every 12 hours, with no PR. The commits on 2026-10-27 are at 00:25, 12:15 and 17:15 UTC,
  all signed by GitHub and attributed to `catena-machine`. The comments in `changelog-auto-merge.yaml` (FE-695) and
  `scheduled-tsp-rebuild.yaml` say `catena-machine` is not an org admin. They're out of date.
- **Why it matters for DCF-5.** `MACHINE_USER_PAT` is shared with every repo. Any workflow that can read the secret
  holds an org-owner token. A `pull_request` workflow from a branch in the same repo can read it, and it can bypass PR
  review in any repo. This is a bigger DCF-5 exposure than the self-approval gap PLAT-552 closed. Raise it with the
  auditor under SEC-84 (owners and rule bypass) and SEC-85 / RISK-023 (the shared token).
- **Fixing it.** Removing the admin role is the fix, but it isn't part of PLAT-552. It also stops the TSP rebuild's
  direct commits to `main`, so that workflow would have to open a PR, or use a narrower bypass, in the same change.
  Check the other `MACHINE_USER_PAT` workflows first, especially `release-protected-branch`, which toggles branch
  protection.

## Phase 2 (optional; decide after Phase 1): "Independent review" required check

This closes gap 1. Do it if the auditor reads DCF-5 as "no author of any commit in the PR may be the approver."

- **Where:** a reusable workflow in `catena-actions` (`.github/workflows/independent-review.yaml`) plus a thin caller
  workflow in each repo. The org ruleset **"Require workflows to pass"** rule can't host it: workflows a ruleset runs
  only support `pull_request`, `pull_request_target` and `merge_group` (confirmed in GitHub's docs, 2026-10-24), so the
  check wouldn't re-run when someone approves.
- **Triggers:** `pull_request` (`opened`, `synchronize`, `ready_for_review`) and `pull_request_review`
  (`submitted`, `dismissed`).
- **Logic:** build the set of people who contributed to the PR, from three sources:
  1. **Pushers.** Every account that pushed to the head branch, from the repo activity API
     (`GET /repos/{owner}/{repo}/activity?ref=refs/heads/<branch>`). GitHub records these pushes itself, so the field
     can't be forged, and it's the same identity `require_last_push_approval` uses.
  2. **Verified committers.** The committer login of each commit in `GET /pulls/{n}/commits` where
     `verification.verified` is `true`. GitHub's verification ties a signature to the committer's email only.
  3. **Self-reported identities.** Author logins, unverified committers, and `Co-authored-by` trailers that resolve to
     org members. Anyone can write these fields, so they only ever add people to the set and never take anyone out.

  Pass only if at least one `APPROVED` review whose `commit_id == head.sha` comes from a login outside that set. Ignore
  `catena-machine`, `github-actions[bot]` and `claude` / Copilot identities, which count as neither contributors nor
  approvers. Don't rely on the ruleset's `required_signatures` rule here: it targets `main`, so commits on PR branches
  don't have to be signed, and even a verified signature doesn't vouch for the author field or the trailers.
  **Remaining limitation:** someone who commits under another person's name and has a colleague push it can still go
  undetected. Pushers (source 1) are the only contributors this check can identify reliably.
- **Enforce:** add the check's name as a required status check in org ruleset `8576896`.
- **Tests:** unit tests for the set logic in `catena-actions/tests/`, plus the same negative and positive PR tests as
  Phase 1, along with a "B pushes last, A approves" case.

## Open questions

1. Who makes the org-ruleset change: Kamal (if an org owner) or another org owner?
2. Phase 2: do it now, or only if the auditor asks? The recommendation is to ship Phase 1 before 2026-10-30 and decide on
   Phase 2 with Compliance (Shano).
3. ~~Does the ruleset leave out any repo that ships to production?~~ No. Checked 2026-10-24: `conditions.repository_name.include`
   is `["~ALL"]` with no exclusions, so the ruleset targets every repo in the org.
