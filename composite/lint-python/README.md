# Lint Python

This composite action configures the environment, then run pre-commit hooks to lint the Python code.

## Usage

Example Workflow:

```yaml
---
name: Lint

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
  lint:
    name: Lint project using pre-commit hooks
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Lint Python
        uses: catenaclearing/catena-actions/composite/lint-python@v0
        with:
          machine_user_pat: ${{ secrets.MACHINE_USER_PAT }}
```
