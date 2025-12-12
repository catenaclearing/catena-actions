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

# Check if INPUT_OPENAPI_DIFF_FILE is set
if [[ -z "${INPUT_OPENAPI_DIFF_FILE}" ]]; then
  echo 'Missing input "openapi_diff_file: path/to/diff.txt".'
  exit 1
fi

# Check if the diff file exists
if [[ ! -f "${INPUT_OPENAPI_DIFF_FILE}" ]]; then
  echo "✗ Error: OpenAPI diff file not found at ${INPUT_OPENAPI_DIFF_FILE}"
  exit 1
fi

# Read the diff from file
echo "Reading OpenAPI diff from: ${INPUT_OPENAPI_DIFF_FILE}"
OPENAPI_DIFF=$(cat "${INPUT_OPENAPI_DIFF_FILE}")

# Read LLM instructions from file
SCRIPT_DIR="$(dirname "$0")"
LLM_INSTRUCTIONS_FILE="${SCRIPT_DIR}/changelog-instructions.md"

if [ ! -f "${LLM_INSTRUCTIONS_FILE}" ]; then
  echo "✗ Error: LLM instructions file not found at ${LLM_INSTRUCTIONS_FILE}"
  exit 1
fi

echo "Reading LLM instructions from: ${LLM_INSTRUCTIONS_FILE}"
LLM_INSTRUCTIONS=$(cat "${LLM_INSTRUCTIONS_FILE}")



echo "Mintlify Project ID: ${INPUT_MINTLIFY_PROJECT_ID}"
echo "OpenAPI diff size: ${#OPENAPI_DIFF} characters"

# Create the request body with separate messages for instructions and diff
REQUEST_BODY=$(jq -n \
  --arg instructions "$LLM_INSTRUCTIONS" \
  --arg diff "$OPENAPI_DIFF" \
  '{
    "messages": [
      {
        "role": "system",
        "content": $instructions
      },
      {
        "role": "system",
        "content": "Here is the git diff of the OpenAPI specification file:\n\n```diff\n\($diff)\n```\n\nPlease analyze this diff and generate a changelog following the instructions provided."
      }
    ],
    "asDraft": false
  }')

echo ""
echo "Creating Mintlify agent job to generate changelog..."
echo "Request body:"
echo "$REQUEST_BODY" | jq .

# Create agent job
response=$(curl --silent --request POST \
  --connect-timeout 30 \
  --max-time 300 \
  --retry 2 \
  --retry-delay 2 \
  --url "https://api.mintlify.com/v1/agent/${INPUT_MINTLIFY_PROJECT_ID}/job" \
  --header "Authorization: Bearer ${INPUT_MINTLIFY_TOKEN}" \
  --header "Content-Type: application/json" \
  --data "$REQUEST_BODY" \
  --write-out "\n%{http_code}" \
  --dump-header /tmp/response_headers.txt)

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
