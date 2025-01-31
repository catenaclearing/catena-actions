# Setup Python and Poetry

This composite action installs and configures Poetry, then installs Python.

## Usage

Example Workflow:

```yaml
---
name: Setup Python and Poetry

on:
  push:
    branches:
      - "*"

permissions:
  contents: read

jobs:
  setup:
    name: Setup Python and Poetry
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Python environment
        uses: catenaclearing/catena-actions/composite/setup-python@v0
        with:
          machine_user_pat: ${{ secrets.MACHINE_USER_PAT }}
```
