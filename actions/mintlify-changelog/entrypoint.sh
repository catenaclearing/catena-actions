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

# Check if INPUT_OPENAPI_DIFF is set
if [[ -z "${INPUT_OPENAPI_DIFF}" ]]; then
  echo 'Missing input "openapi_diff: ${{ steps.diff.outputs.diff }}".'
  exit 1
fi

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
echo "OpenAPI diff size: ${#INPUT_OPENAPI_DIFF} characters"

# Create the request body with separate messages for instructions and diff
REQUEST_BODY=$(jq -n \
  --arg instructions "$LLM_INSTRUCTIONS" \
  --arg diff "$INPUT_OPENAPI_DIFF" \
  '{
    "messages": [
      {
        "role": "system",
        "content": $instructions
      },
      {
        "role": "user",
        "content": "Here is the git diff of the OpenAPI specification file:\n\n```diff\n\($diff)\n```\n\nPlease analyze this diff and generate a changelog following the instructions provided."
      }
    ],
    "asDraft": "true"
  }')

echo ""
echo "Creating Mintlify agent job to generate changelog..."
echo "Request body:"
echo "$REQUEST_BODY" | jq .

# Create agent job
response=$(curl --silent --request POST \
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

# Monitor agent job status
if [ -n "$session_id" ]; then
  echo ""
  echo "Monitoring agent job status..."
  max_attempts=60
  attempt=0

  while [ $attempt -lt $max_attempts ]; do
    sleep 10

    job_status=$(curl --silent --request GET \
      --url "https://api.mintlify.com/v1/agent/${INPUT_MINTLIFY_PROJECT_ID}/job/${session_id}" \
      --header "Authorization: Bearer ${INPUT_MINTLIFY_TOKEN}")

    halted=$(echo "$job_status" | jq -r '.haulted // false')
    halt_reason=$(echo "$job_status" | jq -r '.haultReason // "unknown"')
    branch=$(echo "$job_status" | jq -r '.branch // "unknown"')
    pr_link=$(echo "$job_status" | jq -r '.pullRequestLink // ""')
    message=$(echo "$job_status" | jq -r '.messageToUser // ""')

    echo "Status check $((attempt + 1))/$max_attempts - Halted: ${halted}, Reason: ${halt_reason}"

    if [ "$halted" = "true" ]; then
      echo ""
      echo "Agent job completed!"
      echo "Branch: ${branch}"

      if [ -n "$message" ] && [ "$message" != "null" ]; then
        echo "Message: ${message}"
      fi

      if [ -n "$pr_link" ] && [ "$pr_link" != "null" ]; then
        echo "✓ Pull Request: ${pr_link}"
      fi

      if [ "$halt_reason" = "completed" ]; then
        echo "✓ Changelog generation completed successfully"
        exit 0
      elif [ "$halt_reason" = "error" ]; then
        echo "✗ Agent job failed with error"
        echo "$job_status" | jq .
        exit 1
      elif [ "$halt_reason" = "github_missconfigured" ]; then
        echo "✗ GitHub misconfiguration detected"
        echo "$job_status" | jq .
        exit 1
      else
        echo "⚠ Job halted with reason: ${halt_reason}"
        exit 0
      fi
    fi

    attempt=$((attempt + 1))
  done

  echo "⚠ Agent job monitoring timed out after 10 minutes"
  echo "Last known status:"
  echo "$job_status" | jq .
  exit 1
else
  echo ""
  echo "⚠ No session ID returned, cannot monitor job status"
  echo "✓ Changelog generation job submitted"
fi
