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

## TypeScript CDK apps

Set `language: typescript` for a CDK app written in TypeScript. The default, `python`, is unchanged.

```yaml
      - name: Deploy CDK Stack
        uses: catenaclearing/catena-actions/composite/deploy-cdk@v0
        with:
          language: typescript
          machine_user_pat: ${{ secrets.MACHINE_USER_PAT }}
          role_to_assume: ${{ vars.ROLE_TO_ASSUME }}
          aws_region: ${{ vars.AWS_REGION }}
          stack_name: Example-Development
          directory: infra
```

Instead of the Python environment, the action sets up pnpm and Node 24 and runs `pnpm install --frozen-lockfile` in
`directory`. Your repo needs:

- a `packageManager` field (for example `"pnpm@12.5.1"`) in the root `package.json`, which sets the pnpm version
- a `pnpm-lock.yaml`, and `directory` inside the pnpm project or workspace it belongs to

`machine_user_pat` is passed as `NODE_AUTH_TOKEN` to the install and to `cdk deploy`. The install uses it for private
`@catenaclearing` packages. A Docker image asset can read it as a build secret, for example
`buildSecrets: { node_auth_token: "env=NODE_AUTH_TOKEN" }`. As for Python apps, the token also logs Docker in to
`ghcr.io` and lets git clone private `catenaclearing` repos.

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
this flag overrides the `cdk.json` value.

The flag is only passed when the value isn't `1`, so the default leaves the deploy command exactly as it was.
Values above 1 need CDK CLI 2.1109.0 or later (the flag's first release), which the default `cdk_version:
latest` always is; if you pin an older `cdk_version`, leave this input at its default. Standard GitHub-hosted runners have 2 vCPUs, and most of an image
build is waiting on downloads, cache exports and pushes, so values around 3–4 are a reasonable start.

## The dev lock, and building before it

In the development account, deploys of the repos in `dev_lock_repos` take the global dev lock
([actions/dev-lock](../../actions/dev-lock/README.md)) before deploying. Those deploys first check that this repo owns
the stack (the same guard that runs again right before the deploy), then synthesize the app and publish the stack's
assets (`cdk synth`, then `cdk publish-assets`, which only writes to the CDK bootstrap bucket and
repositories, never to the stack), then take the lock, run the ownership guard, and deploy the assembly they built
(`cdk deploy --app <assembly>`, with the same `catena:managed-by` tag, `exclusively` and `asset_build_concurrency`
as always). A deploy that has to wait for dev therefore waits with its build done.

That deploy leaves out `--force`: with it, `cdk deploy` rebuilds and re-pushes every asset instead of skipping the ones
already published. CDK still deploys whenever the template, tags or parameters differ (so a stack without the
`catena:managed-by` tag still gets it); it skips only a deploy that would change nothing. Every other deploy keeps
`--force`, as before.

`cdk publish-assets` needs CDK CLI 2.1116.0 or later and is still marked unstable by the CDK
(`--unstable=publish-assets`). With an older pinned `cdk_version`, or if building before the lock fails for any reason,
the step only warns and the deploy synthesizes and builds after taking the lock, exactly as before. If the early
ownership check fails, nothing is built or published, and the guard before the deploy stops the job as it always did. Production,
management and every repo outside `dev_lock_repos` skip both the build-first step and the lock, and run the same single
`cdk deploy` they always did.
