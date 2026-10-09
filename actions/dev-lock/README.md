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

| Situation | `report-only` (default) | `enforce` |
|---|---|---|
| Lock is free (or expired) | take it | take it |
| Held by the same repo + actor + ref (e.g. two platform modules from one PR) | join it | join it |
| Held by someone else, **PR / label deploy** | warn, deploy anyway | **fail fast** with the queue position |
| Held by a CI deploy, **merge to main** | warn, deploy anyway | **wait** up to `wait_minutes` (30), then fail |
| Held by a manual hold, **merge to main** | warn, deploy anyway | deploy anyway, and tell the holder |

A merge to main is never stalled by a manual hold because production deploys wait on the dev deploy
(`deploy-production` has `needs: deploy-development`).

A blocked PR deploy is added to the queue as a `notify` entry and keeps it after its job fails, so the
Slack bot can ping that person when dev is free. Acquisition is first come, first served through a
conditional write; the queue order is what the bot announces, it is not enforced by the lock.

## Inputs and outputs

| Input | Default | |
|---|---|---|
| `table_name` | `catena-dev-lock` | |
| `aws_region` | `AWS_REGION` / `AWS_DEFAULT_REGION`, then `us-east-1` | |
| `ttl_minutes` | `60` | How long a lock lasts if its job dies without releasing it. Refreshed on every call within a job |
| `wait_minutes` | `30` | How long a merge to main waits for a CI deploy |
| `poll_seconds` | `15` | |

| Output | |
|---|---|
| `acquired` | `true` when this run holds the lock; `false` in report-only when someone else has it, when the mode is `off`, when a manual hold was overridden, and when the action failed open |
| `blocked` | `true` only when the deploy must stop (dev is locked, mode `enforce`); `false` in every other outcome, including a failed open |

`composite/deploy-cdk` runs this action with `continue-on-error: true` and stops the job itself in a later step
when `blocked` is `true`. That way a bug in the action or an unreachable lock store lets the deploy go ahead,
and only a deliberate block stops it. The action still exits 1 on a block so the step shows red and the reason
is visible.

## Runtime mode (the kill switch)

The mode is read from the table on every run, so changing it needs no release of this repo. A missing
item means `report-only`; an unrecognised value never enforces.

```bash
# enforce | report-only | off
aws dynamodb put-item --table-name catena-dev-lock --item \
  '{"pk": {"S": "CONFIG"}, "sk": {"S": "mode"}, "value": {"S": "off"}}'
```

## It never fails a deploy because the lock is broken

Any error talking to the table (`AccessDenied`, missing table, throttling, timeouts, a bug in this
action) becomes a `::warning::` and the deploy continues without the lock. Only a successful read that
shows a live lock held by someone else can stop a deploy, and only in `enforce` mode. The post step never
fails the job. With the table unreachable, a call adds a few seconds before giving up (3 attempts, 5 s
connect and 10 s request timeouts).

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

* **Acquisition is first come, first served** through the conditional write. Queue order is what the Slack bot
  announces; it is not enforced by the lock.
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
npm run build       # rebuilds dist/
```

**`dist/` is committed and is what GitHub runs.** After changing anything in `src/`, run `npm run build` and commit
the result. A test fails, and so does CI, if the committed `dist/` is not exactly what the build produces. The
repo's `.gitignore` ignores `dist/` in general and has an exception for this one.

Tests run on [dynalite](https://github.com/architect/dynalite), so conditional writes, set operations, reserved
words and consistent reads behave like DynamoDB. `test/dist.test.js` runs the real bundles as separate `node`
processes from an unrelated directory, the way the runner does.

Dependencies are pinned exactly in `package.json` and `package-lock.json`. Bump the AWS SDK packages together.
