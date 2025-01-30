# Open Pull Request

Open a Pull Request from a feature branch to the main branch.

## Usage

Example Workflow:

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


      - name: Pull Request
        uses: catenaclearing/catena-actions/composite/open-pull-request@0
        with:
          github_token: ${{ github.token }}
          title: ${{ github.ref_name }}
```
