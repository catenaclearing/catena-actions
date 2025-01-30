# Open Pull Request

Open a Pull Request from a feature branch to the main branch.

## Usage

Example Workflow:

```yaml
name: Open Pull Request

on: create

permissions:
  contents: read
  pull-requests: write

jobs:
  draft-pull-request:
    name: Draft Pull Request
    runs-on: ubuntu-latest
    if: ${{ github.ref_type == 'branch' }}
    steps:
      - uses: actions/checkout@v4

      - name: Pull Request
        uses: catenaclearing/catena-actions/actions/open-pull-request@0
        with:
          github_token: ${{ github.token }}
          title: ${{ github.ref_name }}
```
