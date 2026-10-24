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
| `pr-185-self-approval-blocked.json` | Negative test (2026-10-24, 20:55–20:58 UTC). [catenaclearing/catena-platform#185](https://github.com/catenaclearing/catena-platform/pull/185) was opened by `catena-machine`, its only commit is by `kamalgill`, and `kamalgill` approved it. All four required checks passed, yet GitHub reports `reviewDecision: REVIEW_REQUIRED` and `mergeStateStatus: BLOCKED` |

The org audit-log REST API returns 404 on this plan, so the ruleset's version history stands in for the audit-log entry.
The ruleset's **History** tab in the UI shows the same thing.

Kamal captured a screenshot of #185's merge box, which shows the approval requirement. The screenshot isn't stored in this
folder.

Still to do: the positive test (a second engineer approves #185 and it becomes mergeable; then close it unmerged and delete
the branch), the `telematics-*` repeat (optional; `repo-coverage.txt` already shows the rule applies there), attaching
evidence to Linear, and comms.

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
  "require_last_push_approval": false,        // <-- the gap
  "require_code_owner_review": false,
  "require_extra_approval_for_unattributed_changes": true,
  "required_review_thread_resolution": false,
  "allowed_merge_methods": ["squash"]
}
```

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
3. **`catena-machine` PAT scope.** The shared token's blast radius is RISK-023 / SEC-85. Out of scope here.

## Phase 2 (optional; decide after Phase 1): "Independent review" required check

This closes gap 1. Do it if the auditor reads DCF-5 as "no author of any commit in the PR may be the approver."

- **Where:** a reusable workflow in `catena-actions` (`.github/workflows/independent-review.yaml`) plus a thin caller
  workflow in each repo. The org ruleset **"Require workflows to pass"** rule can't host it: workflows a ruleset runs
  only support `pull_request`, `pull_request_target` and `merge_group` (confirmed in GitHub's docs, 2026-10-24), so the
  check wouldn't re-run when someone approves.
- **Triggers:** `pull_request` (`opened`, `synchronize`, `ready_for_review`) and `pull_request_review`
  (`submitted`, `dismissed`).
- **Logic:** collect the GitHub logins of every commit author and committer in the PR (`GET /pulls/{n}/commits`, plus
  `Co-authored-by` trailers that resolve to org members). Pass only if at least one `APPROVED` review whose
  `commit_id == head.sha` comes from a login outside that set. Ignore `catena-machine`, `github-actions[bot]` and
  `claude` / Copilot identities, which count as neither authors nor approvers. Signed commits are already required by
  the ruleset (`required_signatures`), which makes commit authorship trustworthy.
- **Enforce:** add the check's name as a required status check in org ruleset `8576896`.
- **Tests:** unit tests for the set logic in `catena-actions/tests/`, plus the same negative and positive PR tests as
  Phase 1, along with a "B pushes last, A approves" case.

## Open questions

1. Who makes the org-ruleset change: Kamal (if an org owner) or another org owner?
2. Phase 2: do it now, or only if the auditor asks? The recommendation is to ship Phase 1 before 2026-10-30 and decide on
   Phase 2 with Compliance (Shano).
3. ~~Does the ruleset leave out any repo that ships to production?~~ No. Checked 2026-10-24: `conditions.repository_name.include`
   is `["~ALL"]` with no exclusions, so the ruleset targets every repo in the org.
