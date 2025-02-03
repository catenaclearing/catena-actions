# Open Pull Request

Open a Pull Request from a feature branch to the main branch.

## Usage

Example Workflow:

```yaml
---
name: Draft Pull Request

on: create

permissions:
  contents: read

jobs:
  draft-pull-request:
    name: Draft Pull Request
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Create Pull Request
        uses: catenaclearing/catena-actions/composite/open-pull-request@v0
        with:
          machine_user_pat: ${{ secrets.MACHINE_USER_PAT }}
```
