# Dev Lock

A global lock on the shared **development** environment, so two people (or two repos) don't deploy over
each other and everyone can see who is using dev. Tracked in PLAT-473.

This is a Docker action. It is meant to be called by `composite/deploy-cdk` (PLAT-478), not by
individual repos. It takes the lock when the deploy starts and gives it back when the job ends
(`post-entrypoint`, which runs on success, failure and cancel).

State lives in the `catena-dev-lock` DynamoDB table, owned by the `DevLock` stack in
`catena-platform` (`infra/dev_lock/README.md` documents the item model). The action uses the AWS
credentials `deploy-cdk` has already configured, so it must run **after** "Configure AWS
credentials". It never posts to Slack: the Slack Lambda reacts to changes in the table.

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
when `blocked` is `true`. That way a failed image build or a bug in the action lets the deploy go ahead, and only
a deliberate block stops it. The action still exits 1 on a block so the step shows red and the reason is visible.

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
shows a live lock held by someone else can stop a deploy, and only in `enforce` mode. `release` never
fails the job. With the table unreachable, a call adds about 7 seconds before giving up.

An unknown command (`entrypoint.sh` / `post.sh` wiring) exits 2 on purpose.

## How expiry works

A lock is free when `expires_at < now`, checked inside the conditional write. DynamoDB TTL is **not** used
for this: it deletes lazily, up to about 48 hours late. The `ttl` attribute only garbage-collects queue
entries. The default 60 minutes must be longer than the longest dev deploy; a job that outlives it can be
overtaken, and the next deploy will take the lock.

## Development

Tests run with the repo's normal gates (`make lint test`); they use moto, so no AWS access is needed.

`tests/test_image.py` builds the image and starts it with GitHub's `--workdir /github/workspace`. This matters:
GitHub ignores the image's `WORKDIR`, so a package that is only importable from `/app` works on a laptop and fails
on a runner. That is why the Dockerfile sets `PYTHONPATH=/app`. The test is skipped when docker is not available.

To run the real image against a local DynamoDB (moto in server mode), build it and point it at the
server with `AWS_ENDPOINT_URL`, passing the GitHub variables the action reads
(`GITHUB_REPOSITORY`, `GITHUB_ACTOR`, `GITHUB_REF`, `GITHUB_RUN_ID`, `GITHUB_JOB`, `GITHUB_EVENT_NAME`,
`GITHUB_OUTPUT`). Use `--entrypoint /post.sh` to run the release step.

```bash
docker build -t dev-lock-test actions/dev-lock
```

The image pins `boto3` to the version in `poetry.lock`, so what ships is what the tests ran against.
Bump them together.

## Testing a change to the lock on a branch

`deploy-cdk@v0` is a floating tag that moves on every release, so a change reaches every repo as soon as it
merges. Test on a branch first. In a throwaway branch (never merged), change the `uses:` line for this action in
`composite/deploy-cdk/action.yaml` from `@v0` to the branch name, and run a deploy with
`dev_lock_repos` set to the repo you are testing from (this repo's own `Deploy CDK` workflow deploys
`DummyActions-Development` to the dev account, so it works as a canary). A test fails if the real branch ever
pins this action to anything but `@v0`, which is what stops a canary pin from being merged by accident.

Needs the `DevLock` stack and the `AllowDevLockTable` grant on `GitHubActionsDeployer` to be deployed to dev.

### Canary checklist

Run these on the branch pin before merging anything that changes `composite/deploy-cdk`. The first one is the one
nobody has been able to settle from the documentation, and the answer decides whether this action should stay a
Docker action.

| # | Run | Look for |
|---|---|---|
| 1 | **A broken image**: on the throwaway branch add `RUN false` to the Dockerfile | The lock step fails but the deploy goes ahead (`continue-on-error`). Then look at the post step: if "Post Take the dev environment lock" fails and turns the job red, a registry outage would fail every dev deploy, and this action should become a JavaScript action (no image to build) |
| 2 | A normal deploy | "Holding the dev lock" in the log (not an `AccessDenied` or `NoCredentialsError` warning, which would mean the AWS credentials did not reach the container); the lock item exists during the deploy and is gone after it |
| 3 | The same deploy again, plus a second deploy started while it runs, in `enforce` mode | The second goes red at "Stop the deploy, dev is locked" with the holder and a queue position; the first is unaffected |
| 4 | Two deploys started at the same moment | Exactly one holder (this is the real DynamoDB check the unit tests cannot make) |
| 5 | A job that is cancelled mid-deploy | The lock is released |
| 6 | The duration of the "Build container" step | Over about 30 seconds is the agreed reason to switch to a JavaScript action |

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
