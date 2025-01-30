# Release Package to protected branch

Bump a Python project version using Commitizen and release a new version in GitHub.

## Usage

Example Workflow using:

```yaml
---
name: Release Package to Protected Branch

on:
  push:
    branches:
      - main

permissions:
  id-token: write
  contents: read

jobs:
  release:
    name: Release Package
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Bump Version and Release to Protected Branch
      uses: catenaclearing/catena-actions/composite/release-protected-branch@v0
        with:
          machine_user_pat: ${{ secrets.MACHINE_USER_PAT }}
```
