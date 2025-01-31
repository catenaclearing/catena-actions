# Build Node

This composite action installs and configures Node.js then builds the project.

## Usage

Example Workflow:

```yaml
---
name: Build Node

on:
  push:
    branches:
      - "*"

permissions:
  contents: read

jobs:
  setup:
    name: Build Node
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Build Node project
        uses: catenaclearing/catena-actions/composite/build-node@v0
        with:
          machine_user_pat: ${{ secrets.MACHINE_USER_PAT }}
```
