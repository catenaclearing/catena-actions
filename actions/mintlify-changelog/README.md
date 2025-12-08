# Generate Mintlify Changelog PR

Trigger a mintlify agent job to create a PR with the changelog from openapi specs.
## Usage

Example Workflow:

```yaml
name: Generate Changelog PR

on:
  push:
    branches:
      - main

permissions:
  id-token: write
  contents: read

jobs:
  api-changelog:
    name: Generate Changelog PR
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Generate Mintlify Changelog PR
        uses: catenaclearing/catena-actions/actions/mintlify-changelog@v0
        with:
          mintlify_project_id: ${{ vars.MINTLIFY_PROJECT_ID }}
          mintlify_token: ${{ secrets.MINTLIFY_TOKEN }}
          openapi_diff: ${{ steps.generate_diff.outputs.openapi_diff }}
```
