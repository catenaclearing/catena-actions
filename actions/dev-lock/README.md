# Dev Lock

A global lock on the shared **development** environment, so two people (or two repos) don't deploy over
each other and everyone can see who is using dev. Tracked in PLAT-473.

This is a JavaScript action. It is meant to be called by `composite/deploy-cdk` (PLAT-478), not by
individual repos. It takes the lock when the deploy starts and gives it back when the job ends
(`post`, which runs on success, failure and cancel).

State lives in the `catena-dev-lock` DynamoDB table, owned by the `DevLock` stack in
`catena-platform` (`infra/dev_lock/README.md` documents the item model). The action uses the AWS
credentials `deploy-cdk` has already configured, so it must run **after** "Configure AWS
credentials". It never posts to Slack: the Slack Lambda reacts to changes in the table.

## Why JavaScript and not Docker

GitHub builds or pulls the image of **every Docker action in a job before the first step runs**: it walks all
the steps, including actions nested inside a composite and including steps whose `if` is false, and queues a
"Build" or "Pull" setup step for each (`ActionManager.PrepareActionsAsync` in `actions/runner`). A failed build
fails the job during setup, where `continue-on-error` cannot help.

`deploy-cdk@v0` is used by every deploy in every repo, production included. A Docker version of this action
would therefore have been built by all of them, and a Docker Hub, PyPI or Debian archive outage would have
failed every deploy. A JavaScript action is only downloaded, with nothing to build or pull. Keep it that way:
`tests/test_dev_lock_action.py` fails if this action, or any action `deploy-cdk` references, becomes a Docker
action.

## What it does

In `report-only` nothing waits or fails, except a PR deploy that opted in with `pr_policy` `wait`: everything else that
finds dev busy warns and deploys at once, as it always has. In `enforce`, a merge to main waits in line, and a PR
deploy fails fast, or waits in line with `pr_policy` `wait`.

| Situation | `report-only` (default) | `enforce`, `pr_policy` `fail` (default) | `pr_policy` `wait`, either mode |
|---|---|---|---|
| Lock is free (or expired), nobody ahead in line | take it | take it | take it |
| Held by the same repo + actor + ref (e.g. two platform modules from one PR) | join it | join it | join it |
| Held by someone else, or free with others ahead in line, **PR / label deploy** | warn, deploy anyway | **fail fast** with the queue position | **wait in line** up to `pr_wait_minutes` (30), then enforce: fail with the queue position; report-only: warn, deploy anyway |
| Held by a CI deploy, or free with others ahead in line, **merge to main** | warn, deploy anyway | **wait in line** up to `wait_minutes` (30), then fail | as the mode says |
| Held by a manual hold, **merge to main** | warn, deploy anyway | take it over, deploy, and tell the holder | as the mode says |

`enforce` and `report-only` are `CONFIG/mode` (`off` skips the lock entirely); `fail` and `wait` are `CONFIG/pr_policy`
(see "Runtime mode" below). Both are read from the table on every run. A PR deploy under `wait` never takes over a
manual hold; it waits for it like anything else. `pr_policy` only changes what PR / label deploys do: a merge to main
behaves the same under either value, so in report-only it never waits and never joins the queue (and so is never
announced as being in line).

## Waiting in line (`CONFIG/pr_policy`, PLAT-590)

With `pr_policy` `wait`, a PR / label deploy that cannot have dev waits in its job until the deploys ahead of it are
done, instead of failing (or, in report-only, deploying at the same time), and deploys as soon as it is its turn.
`composite/deploy-cdk` synthesizes the app and publishes its assets (Docker images, files) before it takes the lock, so the expensive part is already done while it waits, and getting dev only leaves the
CloudFormation deploy.

**Merges to main go first; otherwise the line is first in, first out.** A run takes a free lock only when nobody is
ahead of it in line (`LockStore.waitersAhead`). A holder is in line while a run waits on its queue entry right now: the
entry carries that run's token in `poll_run_ids` and was refreshed in the last `120 s + poll_seconds`. The queue is
ordered by when each holder joined. Ahead of a **merge to main** are only the merges that were waiting before it (and a
turn the Slack bot has started, below); waiting PR deploys never are, because production waits on the merge's dev job
and two or three PRs ahead would push it past `wait_minutes`. Ahead of a **PR deploy** are every waiting merge, wherever
it is in the queue, and the PR deploys that were waiting before it. A waiting run marks which it is with `main_push` on
its entry. So:

* a newcomer does not take dev from under people waiting for it, even when it happens to look the moment dev frees;
* merges take dev one after another in the order they arrived, then the PR deploys in theirs;
* the one exception is a manual hold: a merge to main still takes it over at once whoever is in line, because a hold
  can last hours and production must not wait on it (the PRs in line keep waiting, now for the merge);
* a `notify` entry nobody is waiting on (a deploy that failed fast) holds nobody up. If that person re-runs the job and
  it waits, it keeps the entry and so its original place;
* except during its turn: once the Slack bot has told that person it is their turn (`claim_deadline` set, not yet
  past, no skip in progress), every waiting run, merges included, waits until they claim dev or the window runs out;
* a run whose runner died stops counting once its entry goes stale, and a cancelled one leaves the line in its post step;
* a sibling run of the holder that has dev joins it, whoever is in line.

The line is read, not written, so it is not part of the lock's conditional write: two runs that both see nobody ahead
(for example a newcomer in the instant the head of the line takes the lock) still race, and the conditional write lets
exactly one in. The other then waits behind it. If the queue cannot be read at all, the run warns once and goes by the
lock alone, as before the line existed.

In report-only, a PR deploy that gives up leaves the line and deploys anyway, with a warning. In enforce, a PR deploy that
gives up after `pr_wait_minutes` ends as a fail-fast one does: its entry becomes `notify` (keeping its
place), the error gives its queue position, and the Slack bot pings it when dev is free. `pr_wait_minutes` `0` makes
`wait` behave like `fail`.

### Trade-offs

* **Runner minutes.** A waiting job holds its GitHub runner (and is billed for it) the whole time it waits; with
  `pr_wait_minutes` 30 that is up to 30 minutes per waiting PR, on top of the build. `fail` costs nothing while dev is
  busy, but the re-run builds everything again.
* **The wait limit.** Long enough to get through a typical line, short enough that a stuck holder does not keep a pile
  of runners busy. When it runs out the developer is where `fail` would have put them: red job, queue position, ping.
* **It deploys what it built.** A waiting run deploys the assembly and assets it built when it started, not whatever is
  on the branch by the time it gets dev. Pushing again starts a new run (a new holder only if the ref changes; a new
  push to the same PR is the same holder, so its runs share the place in line).
* **PRs behind merges.** Merges to main go first, so a busy stretch of merges keeps waiting PR deploys waiting, and
  can push one past `pr_wait_minutes`. The queue position shown is the order of arrival, so a merge can say "#3" and
  still go next. Changing the rule is a change to `LockStore.waitersAhead`.
* **The build happens even if the deploy is later blocked.** With `fail`, a blocked PR deploy has already spent its
  build minutes before finding dev locked.

## Inputs and outputs

| Input | Default | |
|---|---|---|
| `table_name` | `catena-dev-lock` | |
| `aws_region` | `AWS_REGION` / `AWS_DEFAULT_REGION`, then `us-east-1` | |
| `ttl_minutes` | `60` | How long a lock lasts if its job dies without releasing it. Each call pushes the expiry out to at least this, never shortens it. At least 1 |
| `wait_minutes` | `30` | How long a merge to main waits in line. At least 0 (0 gives up straight away) |
| `pr_wait_minutes` | `30` | How long a PR / label deploy waits in line when `CONFIG/pr_policy` is `wait`. At least 0 |
| `poll_seconds` | `15` | How often a run waiting in line looks again. At least 1 |

| Output | |
|---|---|
| `acquired` | `true` when this run holds the lock; `false` in report-only when it went ahead without it, when the mode is `off`, when a manual hold was overridden, and when the action failed open |
| `blocked` | `true` only when the deploy must stop (mode `enforce`, and it failed fast or gave up waiting); `false` in every other outcome, including a failed open |

`composite/deploy-cdk` runs this action with `continue-on-error: true` and stops the job itself in a later step
when `blocked` is `true`. That way a bug in the action or an unreachable lock store lets the deploy go ahead,
and only a deliberate block stops it. The action still exits 1 on a block so the step shows red and the reason
is visible. It fails open only while it does not know who holds dev: once it has found someone else holding it, a
queue write that fails is a warning ("queue position unknown") and the deploy is still blocked, or still waits.

## Runtime mode (the kill switch)

The mode is read from the table on every run, so changing it needs no release of this repo. A missing
item means `report-only`; an unrecognised value never enforces.

```bash
# enforce | report-only | off
aws dynamodb put-item --table-name catena-dev-lock --item \
  '{"pk": {"S": "CONFIG"}, "sk": {"S": "mode"}, "value": {"S": "off"}}'

# What an enforced PR / label deploy does when it cannot have dev: fail (fail fast, the default) | wait (wait in line)
aws dynamodb put-item --table-name catena-dev-lock --item \
  '{"pk": {"S": "CONFIG"}, "sk": {"S": "pr_policy"}, "value": {"S": "wait"}}'
```

A missing `pr_policy` item, or any other value, means `fail`. `wait` applies in both `enforce` and `report-only`, and only
to PR / label deploys.

## It never fails a deploy because the lock is broken

Any error talking to the table (`AccessDenied`, missing table, throttling, timeouts, a bug in this
action) becomes a `::warning::` and the deploy continues without the lock. Only a successful read that
shows a live lock held by someone else can stop a deploy, and only in `enforce` mode. The post step never
fails the job.

A broken table is not free, though: each call gets 3 attempts with a 5 s connect timeout and a 10 s request timeout
(`src/client.js`). Measured against the real bundle on Node 24, an address that never answers costs about 15 s per
call, and a server that accepts the connection and then goes silent about 30 s. The first call decides, so a run
pays that once for `acquire`, and once more in the post step. The SDK's `requestTimeout` only logs a warning unless
the handler is told to throw (`throwOnRequestTimeout`, set in `requestHandlerOptions`); without that a silent
server would hang the step until the job's own timeout. `test/client.test.js` guards it.

An unknown command (a wiring bug) exits 2 on purpose.

## How expiry works

A lock is free when `expires_at < now`, checked inside the conditional write, in whole seconds (the store
owns the definition of "now", so the write and the runner cannot disagree). DynamoDB TTL is **not** used for
this: it deletes lazily, up to about 48 hours late. The `ttl` attribute only garbage-collects queue entries.

The default 60 minutes must be longer than the longest dev deploy; a job that outlives it can be overtaken,
and the next deploy will take the lock. The AWS credentials the post step uses are the job's session
credentials, which expire after an hour by default: a job that runs longer than that cannot release the lock
and leaves it to expire on its own.

## Known limitations

* **The line is checked by a read before the conditional write**, so two runs that both see nobody ahead race, and
  whichever write lands first goes first (see "Waiting in line").
* **A job that outlives `ttl_minutes` can be overtaken**, and a job longer than an hour cannot release the lock at
  all (its AWS session has expired), so the lock then expires on its own.
* **A merge to main that goes ahead over a manual hold does not hold the lock itself.** If the hold ends while that
  merge's deploy is still running, a PR deploy can start alongside it. A fix would be to take over the lock for the
  duration and restore the hold afterwards; not done yet.
* **Lock state is only as good as the table.** If the table is unreachable the action fails open (see above), so
  concurrent dev deploys are possible again until it is fixed.

## Testing a change on a branch (the canary)

`deploy-cdk@v0` is a floating tag that moves on every release, so a change reaches every repo as soon as it merges.
Test on a branch first, with a throwaway branch that is never merged. This repo's own `Deploy CDK` workflow deploys
`DummyActions-Development` to the dev account, so it works as the canary. **Two things must change on the branch, not
one**, or the test exercises nothing:

1. In `composite/deploy-cdk/action.yaml`, change this action's `uses:` from `@v0` to the branch name.
2. In `.github/workflows/deploy-cdk.yaml`, change `uses: .../composite/deploy-cdk@main` to the branch name too (the
   workflow does not use the composite from the branch otherwise), and add
   `dev_lock_repos: catenaclearing/catena-actions` under `with:`, since this repo is not in the default list.

A test fails if the real branch ever pins this action to anything but `@v0`, which is what stops a canary pin from
being merged by accident. It needs the `DevLock` stack and the `AllowDevLockTable` grant on `GitHubActionsDeployer`
deployed to dev.

| # | Run | Look for |
|---|---|---|
| 1 | A normal dev deploy | "dev lock: on" from the gate, then "Holding the dev lock" (not an `AccessDenied` or credentials warning: that would mean the AWS credentials did not reach the action). The lock item exists during the deploy and is gone after |
| 2 | A deploy whose CDK step fails (the common case) | The lock is released anyway |
| 3 | A job that is cancelled mid-deploy | The lock is released |
| 4 | In `enforce` mode, a second deploy started while the first runs | The second goes red at "Stop the deploy, dev is locked", names the holder and gives a queue position; the first is unaffected |
| 5 | Two deploys started at the same moment | Exactly one holder. This is the real DynamoDB check the emulator cannot make |
| 6 | With no `CONFIG/mode` item, then set to `enforce`, then to `off` (commands above) | Behaves as report-only, then enforces, then does nothing, each without a release |
| 7 | **A job that must not use the lock**: a production or management deploy, or a repo outside `dev_lock_repos` | "dev lock: off (...)" in the gate's log with the reason, and no lock calls anywhere |
| 8 | The table is unreachable (point `table_name` at a name that does not exist) | A warning, and the deploy goes ahead |

**Not exercisable from a PR:** a merge to main waiting for a CI deploy, or going ahead over a manual hold, because
both depend on the push event on `refs/heads/main`. They are covered by the tests; watch the first real merges.

## Releasing: merge order

`deploy-cdk@v0` is a floating tag that the release workflow moves on every merge to `main` that bumps the version.
This repo's own `Deploy CDK` workflow uses `deploy-cdk@main`, and `composite/deploy-cdk` refers to this action as
`@v0`. If both land in one merge, there is a window between the merge and the release moving `v0` in which `main`'s
composite points at a `v0` that does not contain this action, and that workflow fails at job setup (a nested action
that cannot be resolved fails the whole job; `continue-on-error` does not help).

1. Merge the change to `actions/dev-lock` **on its own** first.
2. Wait for the release: a `bump:` commit appears on `main` and `v0` moves to it. Check with
   `git fetch --tags -f && git rev-parse origin/main v0`; the two must be the same commit.
3. Only then merge the change to `composite/deploy-cdk`.

Do not merge anything else to `main` while a release is running, either. The release (`actions/release`) fetches
`main`, adds its `bump:` commit and then runs `git push origin HEAD:main --force`, so a commit merged in between is
silently erased from `main` and its tag is orphaned. This is how the release process works for every repo that uses it,
not something specific to this action; using `--force-with-lease` there would close it.

## Development

This action has its own Node project; the repo's Python tooling does not run it.

```bash
cd actions/dev-lock
npm ci
npm test            # runs against an in-memory DynamoDB (dynalite), no AWS needed

# The same suite with real transactions, as CI runs it (dynalite has no TransactWriteItems):
docker run -d -p 8000:8000 amazon/dynamodb-local:3.1.0
DEV_LOCK_DYNAMODB_ENDPOINT=http://127.0.0.1:8000 npm test
npm run build       # rebuilds dist/
```

**`dist/` is committed and is what GitHub runs.** After changing anything in `src/`, run `npm run build` and commit
the result. A test fails, and so does CI, if the committed `dist/` is not exactly what the build produces. The
repo's `.gitignore` ignores `dist/` in general and has an exception for this one.

Tests run on [dynalite](https://github.com/architect/dynalite), so conditional writes, set operations, reserved
words and consistent reads behave like DynamoDB. dynalite has no transactions, so `test/support.js` stands in for
them there, and that stand-in only checks what it was written to check. CI therefore runs the whole suite against
DynamoDB Local instead (`DEV_LOCK_DYNAMODB_ENDPOINT`), where every transaction is sent unchanged, and
`test/transactions.test.js` checks the real commits and rollbacks; it is skipped locally without that endpoint and
fails in CI without it. `test/dist.test.js` runs the real bundles as separate `node`
processes from an unrelated directory, the way the runner does.

Dependencies are pinned exactly in `package.json` and `package-lock.json`. Bump the AWS SDK packages together.
