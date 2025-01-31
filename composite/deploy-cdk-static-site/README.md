# Deploy CDK Static Site Stack

This composite action configures the environment, build a Node app and deploys a CDK stack that depends on the Node app.

## Usage

Example Workflow:

```yaml
---
name: Deploy CDK Static Site

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
      - uses: actions/checkout@v4

      - name: Deploy CDK Static Site
        uses: catenaclearing/catena-actions/composite/deploy-cdk-static-site@v0
        with:
          machine_user_pat: ${{ secrets.MACHINE_USER_PAT }}
          role_to_assume: ${{ vars.ROLE_TO_ASSUME }}
          aws_region: ${{ vars.AWS_REGION }}
          stack_name: Actions-Development
```
