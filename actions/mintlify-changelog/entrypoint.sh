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

echo "Mintlify Project ID: ${INPUT_MINTLIFY_PROJECT_ID}"

oasdiff diff "${INPUT_OLD_OPENAPI_FILE}" "${INPUT_NEW_OPENAPI_FILE}" > "${OPENAPI_DIFF_FILE}"

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
echo "Request body:"
echo "$REQUEST_BODY" | jq .

# Write request body to a temp file to avoid "Argument list too long" OS limit
REQUEST_BODY_FILE=$(mktemp /tmp/request_body.XXXXXX.json)
trap 'rm -f "$REQUEST_BODY_FILE"' EXIT
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
trap - EXIT

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
