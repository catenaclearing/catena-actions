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

## Building Docker images in parallel

CDK builds Docker image assets one at a time by default. A stack with several images can build them in
parallel with `asset_build_concurrency` (passed to `cdk deploy` as `--asset-build-concurrency`):

```yaml
      - name: Deploy CDK Stack
        uses: catenaclearing/catena-actions/composite/deploy-cdk@v0
        with:
          # ...
          asset_build_concurrency: 4
```

Set it here, not as `"assetBuildConcurrency"` in `cdk.json`: the CDK CLI's command-line default of 1 for
this flag overrides the `cdk.json` value. Standard GitHub-hosted runners have 2 vCPUs, and most of an image
build is waiting on downloads, cache exports and pushes, so values around 3–4 are a reasonable start.
