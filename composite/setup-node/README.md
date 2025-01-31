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
      - uses: actions/checkout@v4

      - name: Setup Node environment
        uses: catenaclearing/catena-actions/composite/setup-node@0
```
