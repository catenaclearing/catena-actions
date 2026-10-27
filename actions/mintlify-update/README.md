# Update Mintlify Docs

Trigger a documentation update on Mintlify for the specified project and monitor progress.

## Usage

Example Workflow:

```yaml
name: Update Mintlify Docs

on:
  push:
    branches:
      - main

permissions:
  id-token: write
  contents: read

jobs:
  docs:
    name: Update Docs
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6

      - name: Update Mintlify Docs
        uses: catenaclearing/catena-actions/actions/mintlify-update@v0
        with:
          mintlify_project_id: ${{ vars.MINTLIFY_PROJECT_ID }}
          mintlify_token: ${{ secrets.MINTLIFY_TOKEN }}
```

## Behaviour

1. `POST /v1/project/update/{project_id}` triggers the update. Any non-2xx response is printed with its HTTP code and body and fails the job.
2. If the trigger returns a `statusId`, the action polls `GET /v1/project/update-status/{statusId}` until the deployment reports `success` (exit 0) or `failure` (exit 1), or until ~15 minutes have passed (exit 1).
3. Polling starts 30 s after the trigger and backs off by 15 s per check up to 60 s between checks, so a full 15-minute wait costs about 15 requests rather than 90.
4. If a status check is rate limited by Mintlify (HTTP 429 or a `Rate limit exceeded` error body), the action stops polling and exits 0 with a warning: the update was triggered but could not be monitored, so check the Mintlify dashboard. Continuing to poll would keep the limit tripped for the next deploy. A rate-limited *trigger* still fails the job, since nothing was deployed; re-run it a few minutes later.

Mintlify's rate limit is shared across all of our repos (on 2026-10-27 one over-polling deploy blocked triggers from every other repo for half an hour), so several deploys in quick succession share one budget.
