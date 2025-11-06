# Checov Scan

This composite action configures the environment, synthezzises the CDK stack, then runs the Checkov scan to check for security issues.

## Usage

Example Workflow:

```yaml
---
name: Checkov

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
  test:
    name: Tests
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name:
        uses: catenaclearing/catena-actions/composite/checkov@v0
        with:
          machine_user_pat: ${{ secrets.MACHINE_USER_PAT }}
```
