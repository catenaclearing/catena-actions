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

Output `acquired`: `true` when this run holds the lock; `false` in report-only when someone else has it,
when the mode is `off`, when a manual hold was overridden, and when the action failed open.

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

To run the real image against a local DynamoDB (moto in server mode), build it and point it at the
server with `AWS_ENDPOINT_URL`, passing the GitHub variables the action reads
(`GITHUB_REPOSITORY`, `GITHUB_ACTOR`, `GITHUB_REF`, `GITHUB_RUN_ID`, `GITHUB_JOB`, `GITHUB_EVENT_NAME`,
`GITHUB_OUTPUT`). Use `--entrypoint /post.sh` to run the release step.

```bash
docker build -t dev-lock-test actions/dev-lock
```

The image pins `boto3` to the version in `poetry.lock`, so what ships is what the tests ran against.
Bump them together.
