# Release Package

Bump a Python project version using Commitizen and release a new version in GitHub.

## Usage

Example Workflow using:

```yaml
name: Release Package

on:
  push:
    branches:
      - main

permissions:
  id-token: write
  contents: read

jobs:
  release:
    name: Release
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Bump Version and Release
        uses: catenaclearing/catena-actions/actions/release@v0
        with:
          machine_user_pat: ${{ secrets.MACHINE_USER_PAT }}
```
