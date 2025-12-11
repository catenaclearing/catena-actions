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

if [ "$http_code" -ne 200 ] && [ "$http_code" -ne 201 ]; then
  echo "✗ Failed to trigger documentation update (HTTP $http_code)"
  echo "$response_body"
  exit 1
fi

echo "✓ Documentation update triggered successfully"
echo "$response_body"

# Monitor deployment status
echo ""
echo "Waiting for deployment to complete..."
max_attempts=30
attempt=0

while [ $attempt -lt $max_attempts ]; do
  sleep 30

  status=$(curl --silent --request GET \
    --url "https://api.mintlify.com/v1/project/update/${INPUT_MINTLIFY_PROJECT_ID}/status" \
    --header "Authorization: Bearer ${INPUT_MINTLIFY_TOKEN}")

  deployment_status=$(echo "$status" | jq -r '.status // "unknown"')
  echo "Deployment status: $deployment_status (attempt $((attempt + 1))/$max_attempts)"

  if [ "$deployment_status" = "deployed" ]; then
    echo "✓ Documentation successfully deployed!"
    echo "$status" | jq .
    exit 0
  elif [ "$deployment_status" = "failed" ]; then
    echo "✗ Documentation deployment failed"
    echo "$status" | jq .
    exit 1
  fi

  attempt=$((attempt + 1))
done

echo "⚠ Deployment status check timed out after 15 minutes"
echo "Last known status:"
echo "$status" | jq .
exit 1
