# Deploy CDK Stack

This composite action configures the environment and deploys a CDK stack.

## Usage

Example Workflow:

```yaml
---
name: Deploy CDK

on:
  push:
    branches:
      - main
  pull_request:
    types:
      - labeled
      - synchronize

permissions:
  id-token: write
  contents: read

jobs:
  deploy-development:
    name: Development Deploy
    if: |
      (github.event.action == 'labeled' && github.event.label.name == ':test_tube: dev deploy') ||
      (github.event.action != 'labeled' && contains(github.event.pull_request.labels.*.name, ':test_tube: dev deploy')) ||
      (github.event_name == 'push' && github.ref_name == 'main')
    environment: development
    concurrency:
      group: development-${{ github.workflow }}-${{ github.actor }}-${{ github.ref }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6

      - name: Deploy CDK Stack
        uses: catenaclearing/catena-actions/composite/deploy-cdk@v0
        with:
          machine_user_pat: ${{ secrets.MACHINE_USER_PAT }}
          role_to_assume: ${{ vars.ROLE_TO_ASSUME }}
          aws_region: ${{ vars.AWS_REGION }}
          stack_name: Actions-Development
```

## Disk space on GitHub-hosted runners

`ubuntu-latest` only has ~14GB free after preinstalled tooling. This action frees that up
(removes .NET/Android SDK/GHC/CodeQL, disables swap, prunes dangling Docker images) before
anything else runs, so monorepos building several Docker image assets in one `cdk deploy`
don't run out of disk mid-build. Set `free_disk_space: "false"` to skip this on runners where
it doesn't apply (e.g. self-hosted).

If a monorepo has enough Docker image assets that this still isn't sufficient headroom, use a
larger runner (`runs-on:`) in the calling workflow — that's a job-level setting this action
can't control.

## Docker build cache

This action sets up `docker/setup-buildx-action` (driver: `docker-container`) and exposes the
GitHub Actions cache endpoint via `crazy-max/ghaction-github-runtime`. These only take effect
if the CDK app's own Docker image assets are configured with `cacheFrom`/`cacheTo` using the
`gha` cache type (`cdk-assets` passes those straight through as `--cache-from`/`--cache-to` on
the `docker build` it runs) — this action does not add that automatically. If your CDK code
builds several image assets from a shared base + shared dependency layer, give them the same
cache `scope` so that shared layer is reused across images instead of rebuilt/cached separately
per image.
