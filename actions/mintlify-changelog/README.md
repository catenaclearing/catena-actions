# Generate Mintlify Changelog PR

Trigger a mintlify agent job to create a PR with the changelog from OpenAPI spec changes. Uses `oasdiff` to generate structured diffs between OpenAPI 3.x specifications.

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
        with:
          fetch-depth: 2  # Need previous commit to compare

      - name: Get old OpenAPI spec
        run: git show HEAD^:path/to/openapi.json > /tmp/old-openapi.json

      - name: Generate Mintlify Changelog PR
        uses: catenaclearing/catena-actions/actions/mintlify-changelog@v0
        with:
          mintlify_project_id: ${{ vars.MINTLIFY_PROJECT_ID }}
          mintlify_token: ${{ secrets.MINTLIFY_TOKEN }}
          old_openapi_file: /tmp/old-openapi.json
          new_openapi_file: path/to/openapi.json
```

## Inputs

| Input | Description | Required |
|-------|-------------|----------|
| `mintlify_project_id` | Mintlify Project ID | Yes |
| `mintlify_token` | Mintlify Assistant API Token | Yes |
| `old_openapi_file` | Path to the old/base OpenAPI specification file (JSON or YAML) | Yes |
| `new_openapi_file` | Path to the new/changed OpenAPI specification file (JSON or YAML) | Yes |

## How it works

1. Uses `oasdiff` to compare the old and new OpenAPI specifications
2. Generates a structured diff showing new, deleted, and modified endpoints
3. Sends the diff to Mintlify's agent API to generate a changelog PR
