#!/bin/bash

set -e

# Check if INPUT_MINTLIFY_TOKEN is set
if [[ -z "${INPUT_MINTLIFY_TOKEN}" ]]; then
  echo 'Missing input "mintlify_token: ${{ secrets.MINTLIFY_TOKEN }}".'
  exit 1
fi

# Check if INPUT_MINTLIFY_PROJECT_ID is set
if [[ -z "${INPUT_MINTLIFY_PROJECT_ID}" ]]; then
  echo 'Missing input "mintlify_project_id: ${{ vars.MINTLIFY_PROJECT_ID }}".'
  exit 1
fi

# Check if INPUT_OLD_OPENAPI_FILE is set
if [[ -z "${INPUT_OLD_OPENAPI_FILE}" ]]; then
  echo 'Missing input "old_openapi_file: path/to/old.yaml".'
  exit 1
fi

# Check if INPUT_NEW_OPENAPI_FILE is set
if [[ -z "${INPUT_NEW_OPENAPI_FILE}" ]]; then
  echo 'Missing input "new_openapi_file: path/to/new.yaml".'
  exit 1
fi

# Check if the old OpenAPI file exists
if [[ ! -f "${INPUT_OLD_OPENAPI_FILE}" ]]; then
  echo "✗ Error: Old OpenAPI file not found at ${INPUT_OLD_OPENAPI_FILE}"
  exit 1
fi

# Check if the new OpenAPI file exists
if [[ ! -f "${INPUT_NEW_OPENAPI_FILE}" ]]; then
  echo "✗ Error: New OpenAPI file not found at ${INPUT_NEW_OPENAPI_FILE}"
  exit 1
fi

# Read LLM instructions from file
SCRIPT_DIR="$(dirname "$0")"
LLM_INSTRUCTIONS_FILE="${SCRIPT_DIR}/changelog-instructions.md"
OPENAPI_DIFF_FILE="${SCRIPT_DIR}/oasdiff-output.txt"

# Check if the instructions file exists
if [ ! -f "${LLM_INSTRUCTIONS_FILE}" ]; then
  echo "✗ Error: LLM instructions file not found at ${LLM_INSTRUCTIONS_FILE}"
  exit 1
fi

MAX_NEW_ENDPOINTS="${INPUT_MAX_NEW_ENDPOINTS:-40}"

# Validated up front because `[[ ... -gt ... ]]` compares in an arithmetic
# context, where an identifier-shaped value like "abc" is read as an unset
# variable and silently becomes 0. The comparison then passes every diff,
# disabling the one guard a wrong value is most likely reaching for.
if [[ ! "${MAX_NEW_ENDPOINTS}" =~ ^[0-9]+$ ]]; then
  echo "✗ Error: max_new_endpoints must be a non-negative integer, got '${MAX_NEW_ENDPOINTS}'."
  exit 1
fi

echo "Mintlify Project ID: ${INPUT_MINTLIFY_PROJECT_ID}"

# A spec with no endpoints, so oasdiff can be used to count what a spec holds.
EMPTY_SPEC=$(mktemp /tmp/empty-spec.XXXXXX.yaml)
trap 'rm -f "$EMPTY_SPEC"' EXIT
cat > "$EMPTY_SPEC" <<'EMPTY'
openapi: 3.0.0
info:
  title: empty
  version: 0.0.0
paths: {}
EMPTY

# Collapsed to one line: these files can be HTTP error bodies, and a `::`
# sequence at the start of a line in a step's output is read by the runner as a
# workflow command. The single quotes keep the shell off the escapes; tr expands
# them itself, so CR and LF are the characters matched, not backslash-r-n.
quote_head() {
  head -c 400 "$1" | tr '\r\n' '  '
  echo ""
}

count_endpoints() {
  oasdiff summary --format json "$EMPTY_SPEC" "$1" | jq '.details.endpoints.added // 0'
}

# Guardrail 1: the baseline has to be a real API description.
#
# Ref FE-600. Every caller fetches the baseline over HTTP with `curl -s`, which
# returns 0 on an HTTP error, and the gateway answers 413 for the larger specs
# with a valid-JSON error body. That body parses cleanly and yields a spec with
# no endpoints, so oasdiff reports the entire surface as new and the agent has
# no reason to doubt it — six such changelogs were published as releases.
old_endpoints=$(count_endpoints "${INPUT_OLD_OPENAPI_FILE}")
new_endpoints=$(count_endpoints "${INPUT_NEW_OPENAPI_FILE}")
echo "Baseline endpoints: ${old_endpoints}    new spec endpoints: ${new_endpoints}"

if [[ "${old_endpoints}" -eq 0 ]]; then
  echo "✗ Error: the baseline at ${INPUT_OLD_OPENAPI_FILE} describes no endpoints."
  echo "  Every endpoint would read as new. Check how the baseline is obtained —"
  echo "  an HTTP error body parses as valid JSON but is not an API description."
  quote_head "${INPUT_OLD_OPENAPI_FILE}"
  exit 1
fi

if [[ "${new_endpoints}" -eq 0 ]]; then
  echo "✗ Error: the new spec at ${INPUT_NEW_OPENAPI_FILE} describes no endpoints."
  echo "  Every endpoint would read as deleted. The spec build has probably failed."
  quote_head "${INPUT_NEW_OPENAPI_FILE}"
  exit 1
fi

# Guardrail 2: do not wake the agent for a deploy that changed no API.
# Without this the agent is asked to describe an empty diff and left to notice
# that itself, which is where the mintlify/chore-no-api-changes-* PRs come from.
summary=$(oasdiff summary --format json "${INPUT_OLD_OPENAPI_FILE}" "${INPUT_NEW_OPENAPI_FILE}")
echo "oasdiff summary: ${summary}"

if [[ "$(jq -r '.diff' <<< "${summary}")" != "true" ]]; then
  echo "✓ No API changes in this deploy; not creating a changelog job."
  exit 0
fi

# Guardrail 3: a release adds a handful of endpoints, not a whole surface. This
# is the same threshold the docs repo refuses an entry at, so a dump that gets
# past here would be rejected at merge anyway — better to stop it before a PR
# exists. Raise `max_new_endpoints` on the caller for a genuine bulk release.
added=$(jq '.details.endpoints.added // 0' <<< "${summary}")
if [[ "${added}" -gt "${MAX_NEW_ENDPOINTS}" ]]; then
  echo "✗ Error: the diff reports ${added} new endpoints, over the ${MAX_NEW_ENDPOINTS} allowed."
  echo "  That is an API surface, not a release. Check the baseline is the"
  echo "  currently published spec, or raise max_new_endpoints for a real"
  echo "  bulk release."
  exit 1
fi

# `--format text` is the format changelog-instructions.md documents, heading for
# heading ("### New Endpoints: N"). The default is YAML, so until now the agent
# was briefed on one format and handed another — and YAML is six times the size
# for the same change.
oasdiff diff --format text "${INPUT_OLD_OPENAPI_FILE}" "${INPUT_NEW_OPENAPI_FILE}" > "${OPENAPI_DIFF_FILE}"

echo ""
echo "oasdiff diff:"
cat "${OPENAPI_DIFF_FILE}"

# Create the request body with separate messages for instructions and diff
REQUEST_BODY=$(jq -n \
  --rawfile instructions "$LLM_INSTRUCTIONS_FILE" \
  --rawfile diff "$OPENAPI_DIFF_FILE" \
  '{
    "messages": [
      {
        "role": "system",
        "content": $instructions
      },
      {
        "role": "system",
        "content": "Here is the oasdiff output comparing the old and new OpenAPI specifications:\n\n```\n\($diff)\n```\n\nPlease analyze this diff and generate a changelog following the instructions provided."
      }
    ],
    "asDraft": false
  }')

echo ""
echo "Creating Mintlify agent job to generate changelog..."
# The instructions are static and long; logging them on every run buried the
# one part of the payload that varies. The diff itself is printed above.
echo "Request body: $(wc -c <<< "$REQUEST_BODY" | tr -d ' ') bytes" \
  "(instructions $(wc -c < "$LLM_INSTRUCTIONS_FILE" | tr -d ' '), diff $(wc -c < "$OPENAPI_DIFF_FILE" | tr -d ' '))"

# Write request body to a temp file to avoid "Argument list too long" OS limit
REQUEST_BODY_FILE=$(mktemp /tmp/request_body.XXXXXX.json)
trap 'rm -f "$REQUEST_BODY_FILE" "$EMPTY_SPEC"' EXIT
printf '%s' "$REQUEST_BODY" > "$REQUEST_BODY_FILE"

# Create agent job
response=$(curl --silent --show-error --request POST \
  --http1.1 \
  --connect-timeout 30 \
  --max-time 300 \
  --retry 2 \
  --retry-delay 2 \
  --url "https://api.mintlify.com/v1/agent/${INPUT_MINTLIFY_PROJECT_ID}/job" \
  --header "Authorization: Bearer ${INPUT_MINTLIFY_TOKEN}" \
  --header "Content-Type: application/json" \
  --data "@${REQUEST_BODY_FILE}" \
  --write-out "\n%{http_code}" \
  --dump-header /tmp/response_headers.txt)
rm -f "$REQUEST_BODY_FILE"
trap 'rm -f "$EMPTY_SPEC"' EXIT

http_code=$(echo "$response" | tail -n1)
response_body=$(echo "$response" | sed '$d')

# Extract session ID from headers
session_id=$(grep -i "x-session-id:" /tmp/response_headers.txt | cut -d' ' -f2 | tr -d '\r\n' || echo "")

if [ "$http_code" -ne 200 ] && [ "$http_code" -ne 201 ] && [ "$http_code" -ne 202 ]; then
  echo "✗ Failed to create agent job (HTTP $http_code)"
  echo "$response_body"
  exit 1
fi

echo "✓ Agent job created successfully"

if [ -n "$session_id" ]; then
  echo "Session ID: ${session_id}"
fi

echo ""
echo "Agent response (streaming):"
echo "$response_body"

echo ""
echo "✓ Changelog generation job submitted and running asynchronously"
echo "The agent will analyze the OpenAPI diff and create a pull request when complete"

exit 0
