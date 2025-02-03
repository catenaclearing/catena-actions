# Test Python and Run SonarQube

This composite action configures the environment, then runs the Python tests and SonarQube analysis.

## Usage

Example Workflow:

```yaml
---
name: Test

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
    name: Tests + SonarQube
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Test Python and Run SonarQube
        uses: catenaclearing/catena-actions/composite/test-python@v0
        with:
          machine_user_pat: ${{ secrets.MACHINE_USER_PAT }}
          aws_region: ${{ vars.AWS_REGION }}
          sonar_token: ${{ secrets.SONAR_TOKEN }}
```
