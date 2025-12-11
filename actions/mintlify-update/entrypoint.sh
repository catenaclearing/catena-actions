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

echo "Mintlify Project ID: ${INPUT_MINTLIFY_PROJECT_ID}"

# Trigger Mintlify documentation update
echo "Triggering Mintlify documentation update..."
trigger_response=$(curl --silent --request POST \
  --url "https://api.mintlify.com/v1/project/update/${INPUT_MINTLIFY_PROJECT_ID}" \
  --header "Authorization: Bearer ${INPUT_MINTLIFY_TOKEN}" \
  --write-out "\n%{http_code}" \
  --fail-with-body)

http_code=$(echo "$trigger_response" | tail -n1)
response_body=$(echo "$trigger_response" | sed '$d')

if [ "$http_code" -ne 200 ] && [ "$http_code" -ne 201 ] && [ "$http_code" -ne 202 ]; then
  echo "✗ Failed to trigger documentation update (HTTP $http_code)"
  echo "$response_body"
  exit 1
fi

echo "✓ Documentation update triggered successfully"
echo "$response_body"

# Extract status ID from response
status_id=$(echo "$response_body" | jq -r '.statusId // ""')

if [ -z "$status_id" ]; then
  echo "⚠ No status ID returned, cannot monitor deployment"
  exit 0
fi

echo "Status ID: ${status_id}"

# Monitor deployment status
echo ""
echo "Waiting for deployment to complete..."
max_attempts=90
attempt=0

while [ $attempt -lt $max_attempts ]; do
  sleep 10

  response=$(curl --silent --request GET \
    --url "https://api.mintlify.com/v1/project/update-status/${status_id}" \
    --header "Authorization: Bearer ${INPUT_MINTLIFY_TOKEN}")

  deployment_status=$(echo "$response" | jq -r '.status // ""')
  summary=$(echo "$response" | jq -r '.summary // ""')
  commit_sha=$(echo "$response" | jq -r '.commit.sha // ""')
  commit_ref=$(echo "$response" | jq -r '.commit.ref // ""')

  if [ -z "$deployment_status" ]; then
    echo "⚠ Unable to retrieve status (attempt $((attempt + 1))/$max_attempts)"
    echo "Response: $response"
  else
    echo "Deployment status: $deployment_status (attempt $((attempt + 1))/$max_attempts)"
    if [ -n "$summary" ]; then
      echo "Summary: $summary"
    fi
    if [ -n "$commit_sha" ]; then
      echo "Commit: $commit_sha"
    fi
    if [ -n "$commit_ref" ]; then
      echo "Ref: $commit_ref"
    fi
  fi

  if [ "$deployment_status" = "success" ]; then
    echo ""
    echo "✓ Documentation successfully deployed!"
    echo "Full response:"
    echo "$response" | jq .
    exit 0
  elif [ "$deployment_status" = "failure" ]; then
    echo ""
    echo "✗ Documentation deployment failed"
    echo "Full response:"
    echo "$response" | jq .
    exit 1
  fi

  attempt=$((attempt + 1))
done

echo "⚠ Deployment status check timed out after 15 minutes"
echo "Last known status:"
echo "$response" | jq .
exit 1
