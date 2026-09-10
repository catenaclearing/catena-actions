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
      - uses: actions/checkout@v6

      # The baseline is the spec currently published. Fetch it with `-f` so an
      # HTTP error fails the step: without it curl exits 0 and writes the error
      # body, which parses as valid JSON but describes no endpoints, and the
      # whole API surface then reads as new (ref FE-600).
      - name: Get old OpenAPI spec
        run: |
          curl -fsS --retry 3 --retry-delay 5 --retry-all-errors --max-time 60 \
            https://api.example.com/v2/openapi.json -o /tmp/old-openapi.json

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
| `max_new_endpoints` | Refuse the diff when it reports more new endpoints than this (default `40`) | No |

## How it works

1. Uses `oasdiff` to compare the old and new OpenAPI specifications
2. Generates a structured diff showing new, deleted, and modified endpoints
3. Sends the diff to Mintlify's agent API to generate a changelog PR

## Guardrails

A changelog entry records a change, so the action refuses to ask for one when
the diff does not describe a change. Ref FE-600, where a baseline that
described no endpoints had the entire Telematics API surface published as six
separate releases.

| Condition | Outcome |
|-----------|---------|
| Either spec describes no endpoints | Fails the step, with the first 400 bytes of the offending file |
| `oasdiff` reports no difference | Succeeds without creating a job — no PR, no agent run |
| More new endpoints than `max_new_endpoints` | Fails the step; raise the input for a genuine bulk release |

The endpoint threshold matches the one the docs repository refuses a changelog
entry at, so a surface dump is stopped before a pull request exists rather than
at merge.
