# Setup Node

This composite action installs and configures Node.js.

## Usage

Example Workflow:

```yaml
---
name: Setup Node

on:
  push:
    branches:
      - "*"

permissions:
  contents: read

jobs:
  setup:
    name: Setup Node
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6

      - name: Setup Node environment
        uses: catenaclearing/catena-actions/composite/setup-node@v0
        with:
          machine_user_pat: ${{ secrets.MACHINE_USER_PAT }}
```

## Private repositories

`machine_user_pat` is saved with git's credential store for `https://github.com`, so dependencies cloned from our private repositories authenticate with it. It is not put in the clone URL: newer curl versions strip credentials from URLs, and git then drops them.
