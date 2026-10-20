# Setup Python and Poetry

This composite action installs and configures Poetry, then installs Python.

## Usage

Example Workflow:

```yaml
---
name: Setup Python and Poetry

on:
  push:
    branches:
      - "*"

permissions:
  contents: read

jobs:
  setup:
    name: Setup Python and Poetry
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6

      - name: Setup Python environment
        uses: catenaclearing/catena-actions/composite/setup-python@v0
        with:
          machine_user_pat: ${{ secrets.MACHINE_USER_PAT }}
```

## Private repositories

`machine_user_pat` is saved with git's credential store for `https://github.com`, so dependencies cloned from our private repositories authenticate with it. It is not put in the clone URL: newer curl versions strip credentials from URLs, and git then drops them.
