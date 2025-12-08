# LLM Agent Instructions: Generating API Changelogs from OpenAPI Diffs

## Overview
Analyze OpenAPI specification diffs and generate professional changelogs following Mintlify documentation standards.

## Input
- **OpenAPI Diff**: Git diff with additions (`+`), deletions (`-`), and context lines

## Task
1. Analyze the diff for: removed/added/renamed endpoints, parameter changes, response changes, schema modifications
2. Generate a Mintlify-formatted changelog in `api-reference/changelog.mdx`
3. Detect breaking changes vs. improvements
4. Provide migration examples for breaking changes

## Output Format

### Frontmatter
```yaml
---
title: API Changelog
description: Track updates, breaking changes, and improvements to the API
icon: clock-rotate-left
iconType: duotone
mode: wide
---
```

### Structure
```markdown
## [Month Year] - [Release Title]

<Update label="v[X.Y.Z] - [Brief Description]" description="[Summary]">

[Intro paragraph]

<Warning>
**Breaking Changes:** [Summary if applicable]
</Warning>

### Endpoint Changes
<AccordionGroup>
  <Accordion title="[Category]" icon="[icon]">
    **Removed:**
    - `GET /old/endpoint` - Description

    **Added:**
    - `GET /new/endpoint` - Description

    **Migration:**
    ```bash
    # Before
    GET /old/endpoint?param=value

    # After
    GET /new/endpoint?new_param=value
    ```
  </Accordion>
</AccordionGroup>

### Parameter Changes
| Old Parameter | New Parameter | Change Description |
|--------------|---------------|-------------------|
| `old_name` | `new_name` | [Details] |

**Migration:**
```bash
# Before
GET /endpoint?old=val

# After
GET /endpoint?new=val
```

### New Features
<AccordionGroup>
  <Accordion title="[Feature]" icon="[icon]">
    [Description]

    ```bash
    GET /new/feature
    ```
  </Accordion>
</AccordionGroup>

</Update>
```

## Guidelines

### Icons
- `book`: Reference data
- `filter`: Filtering
- `list`: Lists/collections
- `compress`: Consolidations
- `calendar-day`: Time-based features

### Breaking Changes
Always include:
1. What changed (before/after)
2. Migration path with code examples
3. Impact on existing usage

### Writing Style
- Be direct and specific
- Use active voice
- Include exact endpoint paths and parameter names
- Show realistic values in examples
- Use `<Warning>` for breaking changes
- Use `<Tip>` for best practices

### Detect Patterns
- **Renames**: Similar paths/params with `-` and `+` pairs
- **Type changes**: `string` → `array` (singular → plural params)
- **Consolidations**: Multiple endpoints replaced by one with params

## Version Detection
Extract version from diff: `- "version": "old"` and `+ "version": "new"`
Use the current date for the release date.

## Output
Single markdown file with:
- Valid Mintlify frontmatter
- H2 for releases, H3 for categories
- Properly formatted components
- Code blocks with language tags
- No placeholder text
