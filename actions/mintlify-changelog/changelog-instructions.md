# LLM Agent Instructions: Generating API Changelogs from OpenAPI Diffs

## Overview
Analyze OpenAPI specification diffs and generate professional changelogs following Mintlify documentation standards with versioned changelog files.

## Input
- **OpenAPI Diff**: Git diff with additions (`+`), deletions (`-`), and context lines

## Important: Ignore Infrastructure Changes
**CRITICAL**: Ignore changes to the `servers` section in the OpenAPI specification. These are environment-specific URLs (e.g., localhost vs. production) and should NOT be included in changelogs or affect version detection.

Example to ignore:
```diff
- "url": "https://api.catenatelematics.com"
+ "url": "http://localhost:5001"
```

Similarly, ignore changes to authentication URLs that are environment-specific (e.g., `authorizationUrl`, `tokenUrl`, `refreshUrl` with different domains).

## Task
1. Analyze the diff for: removed/added/renamed endpoints, parameter changes, response changes, schema modifications
2. Create a new versioned changelog file in `api-reference/changelogs/` directory
3. Update the main `api-reference/changelogs.mdx` file with a new `<Update>` entry
4. Detect breaking changes vs. improvements
5. Provide migration examples for breaking changes
6. In doubt look at the current changelogs for style reference and follow the same patterns

## Output Structure

### Step 1: Create Versioned Changelog File
**Filename format**: `api-reference/changelogs/v[X.Y.Z]-[YYYY-MM-DD].mdx`
Example: `api-reference/changelogs/v2.1.0-2025-12-02.mdx`

#### Frontmatter
```yaml
---
title: "v[X.Y.Z] - [Release Title]"
description: "[Brief description of changes]"
icon: rocket
iconType: duotone
---
```

#### Content Structure
```markdown
<Update label="v[X.Y.Z] - [Release Title]" description="[Day Month Year]">

[Intro paragraph explaining the release focus]

<Check>
**[Release Type]:** [Explanation of release significance]
</Check>

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

### Migration Checklist
<Steps>
  <Step title="[Action Item]">
    [Details and instructions]
  </Step>
</Steps>

</Update>

---

## Need Help?

<CardGroup cols={2}>
  <Card title="API Reference" icon="book" href="/api-reference/telematics-api">
    View complete endpoint documentation with current API structure
  </Card>

  <Card title="Contact Support" icon="life-ring" href="mailto:support@catenaclearing.io">
    Questions about migrating your integration? Our team is here to help
  </Card>
</CardGroup>
```

### Step 2: Update Main Changelog Page
Add a new `<Update>` component to `api-reference/changelogs.mdx` (add it ABOVE existing updates for reverse chronological order):

```markdown
<Update label="v[X.Y.Z] - [Release Title]" description="[Day Month Year]">

[1-2 sentence summary of the release]

[View full changelog →](/api-reference/changelogs/v[X.Y.Z]-[YYYY-MM-DD])
### Key Changes

- **[Category 1]:** [Brief description]
- **[Category 2]:** [Brief description]
- **[Category 3]:** [Brief description]
- **[Category 4]:** [Brief description]
- **[Category 5]:** [Brief description]

</Update>

---
```

**Important**: Place new updates at the top (after the intro text, before older updates) for reverse chronological order.

## Guidelines

### Icons
- `book`: Reference data
- `filter`: Filtering
- `list`: Lists/collections
- `compress`: Consolidations
- `calendar-day`: Time-based features
- `rocket`: Major releases
- `sparkles`: New features
- `wrench`: Improvements

### Breaking Changes
Always include:
1. What changed (before/after)
2. Migration path with code examples
3. Impact on existing usage
4. Use `<Warning>` callouts for breaking changes

### Writing Style
- Be direct and specific
- Use active voice
- Include exact endpoint paths and parameter names
- Show realistic values in examples
- Use `<Warning>` for breaking changes
- Use `<Tip>` for best practices
- Use `<Check>` for positive confirmations

### Detect Patterns
- **Renames**: Similar paths/params with `-` and `+` pairs
- **Type changes**: `string` → `array` (singular → plural params)
- **Consolidations**: Multiple endpoints replaced by one with params

## Version Detection

### Extracting Current Version
- Extract version from diff: `- "version": "old"` and `+ "version": "new"`
- Use the current date for the release date in YYYY-MM-DD format
- Version format: v[MAJOR].[MINOR].[PATCH]

### Semantic Versioning Rules

Determine the version bump based on the types of changes in the diff:

**PATCH (0.0.X) - Cosmetic/Documentation Changes:**
- Adding or updating `examples` fields in schemas
- Changing `description` fields
- Adding or updating `title` fields
- Marking fields as `deprecated`
- Documentation-only changes
- Fixing typos or clarifications
- No functional API behavior changes

**MINOR (0.X.0) - Backward-Compatible Additions:**
- New endpoints added
- New optional query parameters
- New optional fields in request bodies
- New fields in response bodies
- New optional headers
- New enum values (if additive)
- New features that don't break existing usage

**MAJOR (X.0.0) - Breaking Changes:**
- Endpoints removed or renamed
- Query parameters removed or renamed
- Required parameters added
- Request/response body fields removed or renamed
- Response structure changes
- Field type changes (e.g., string → integer)
- Enum values removed
- Authentication changes
- URL structure changes

**Priority**: If the diff contains multiple types of changes, use the highest version bump (breaking > minor > patch)

## Date Format
- **Filename**: YYYY-MM-DD (e.g., `2025-12-02`)
- **Update description**: YYYY-MM-DD (e.g., `2025-12-02`)
- **Display text**: Day Month Year (e.g., `2nd December 2025`)

## Quality Checks

Before completing, verify the generated files meet these quality standards:

### Basic Linting
- **End of files**: Ensure files end with a single newline
- **Trailing whitespace**: Remove any trailing spaces from lines
- **YAML frontmatter**: Validate frontmatter syntax is correct
- **JSON code blocks**: Ensure any JSON examples are valid
- **Merge conflicts**: No conflict markers (<<<<<<, ======, >>>>>>)
- **Broken links**: All internal links reference valid files/anchors
- **Markdown syntax**: Proper formatting of headers, lists, code blocks

### Mintlify-Specific
- Valid component syntax for `<Update>`, `<Accordion>`, `<Warning>`, `<Tip>`, `<Check>`, `<Steps>`
- Proper nesting and closing of all components
- Icons use valid Mintlify icon names
- Links use correct relative paths

## Output Checklist
- [ ] Correct versioning based on changes
- [ ] Created new file: `api-reference/changelogs/v[X.Y.Z]-[YYYY-MM-DD].mdx`
- [ ] Added `<Update>` entry to `api-reference/changelogs.mdx`
- [ ] Valid Mintlify frontmatter in both files
- [ ] H2 for releases, H3 for categories
- [ ] Properly formatted components
- [ ] Code blocks with language tags
- [ ] No placeholder text
- [ ] Migration examples for breaking changes
- [ ] Consistent date formatting
- [ ] Files end with single newline
- [ ] No trailing whitespace
- [ ] Valid YAML and JSON syntax
- [ ] No broken links or merge conflicts
