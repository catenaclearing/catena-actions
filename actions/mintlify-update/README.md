# Update Mintlify Docs

Trigger a documentation update on Mintlify for the specified project and monitor progress.

## Usage

Example Workflow:

```yaml
name: Update Mintlify Docs

on:
  push:
    branches:
      - main

permissions:
  id-token: write
  contents: read

jobs:
  docs:
    name: Update Docs
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Update Mintlify Docs
        uses: catenaclearing/catena-actions/actions/mintlify-update@v0
        with:
          mintlify_project_id: ${{ vars.MINTLIFY_PROJECT_ID }}
          mintlify_token: ${{ secrets.MINTLIFY_TOKEN }}
```
