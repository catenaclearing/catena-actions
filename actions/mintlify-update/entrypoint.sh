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

# Polling cadence for the update-status endpoint. Mintlify's rate limit is
# shared across our repos, and back-to-back deploys (five API services)
# each used to poll every 10 s for up to 15 min, which tripped the limit and
# then blocked every trigger from every repo for the next half hour.
poll_initial_delay=30   # seconds before the first status check
poll_delay_step=15      # added after every check...
poll_max_delay=60       # ...until the delay reaches this ceiling
poll_max_wait=900       # give up monitoring after ~15 minutes

# Read a field out of a JSON body without aborting the script (set -e) when
# the body is not JSON, e.g. an HTML error page from a proxy.
json_field() {
  echo "$1" | jq -r "$2" 2>/dev/null || true
}

# True when a response body or HTTP code says Mintlify is rate limiting us.
is_rate_limited() {
  local http_code="$1"
  local body="$2"
  if [ "$http_code" = "429" ]; then
    return 0
  fi
  local error
  error=$(json_field "$body" '.error // ""')
  case "$error" in
    *[Rr]ate\ limit*) return 0 ;;
  esac
  return 1
}

echo "Mintlify Project ID: ${INPUT_MINTLIFY_PROJECT_ID}"

# Trigger Mintlify documentation update.
#
# No --fail-with-body here: under set -e a non-2xx would make curl exit
# non-zero inside the command substitution and kill the script before the
# status check below could print the HTTP code and body.
echo "Triggering Mintlify documentation update..."
curl_exit=0
trigger_response=$(curl --silent --show-error --request POST \
  --url "https://api.mintlify.com/v1/project/update/${INPUT_MINTLIFY_PROJECT_ID}" \
  --header "Authorization: Bearer ${INPUT_MINTLIFY_TOKEN}" \
  --write-out "\n%{http_code}") || curl_exit=$?

if [ "$curl_exit" -ne 0 ]; then
  echo "✗ Failed to reach the Mintlify API (curl exit code $curl_exit)"
  echo "$trigger_response"
  exit 1
fi

http_code=$(echo "$trigger_response" | tail -n1)
response_body=$(echo "$trigger_response" | sed '$d')

if [ "$http_code" != "200" ] && [ "$http_code" != "201" ] && [ "$http_code" != "202" ]; then
  echo "✗ Failed to trigger documentation update (HTTP $http_code)"
  echo "$response_body"
  if is_rate_limited "$http_code" "$response_body"; then
    echo "Mintlify is rate limiting us. Re-run this job in a few minutes once earlier deploys have finished polling."
  fi
  exit 1
fi

echo "✓ Documentation update triggered successfully"
echo "$response_body"

# Extract status ID from response
status_id=$(json_field "$response_body" '.statusId // ""')

if [ -z "$status_id" ]; then
  echo "⚠ No status ID returned, cannot monitor deployment"
  exit 0
fi

echo "Status ID: ${status_id}"

# Monitor deployment status
echo ""
echo "Waiting for deployment to complete (polling every ${poll_initial_delay}-${poll_max_delay}s for up to $((poll_max_wait / 60)) minutes)..."
delay=$poll_initial_delay
elapsed=0
attempt=0
response=""

while [ $elapsed -lt $poll_max_wait ]; do
  sleep "$delay"
  elapsed=$((elapsed + delay))
  attempt=$((attempt + 1))
  if [ $delay -lt $poll_max_delay ]; then
    delay=$((delay + poll_delay_step))
    if [ $delay -gt $poll_max_delay ]; then
      delay=$poll_max_delay
    fi
  fi

  curl_exit=0
  poll_response=$(curl --silent --show-error --request GET \
    --url "https://api.mintlify.com/v1/project/update-status/${status_id}" \
    --header "Authorization: Bearer ${INPUT_MINTLIFY_TOKEN}" \
    --write-out "\n%{http_code}") || curl_exit=$?

  if [ "$curl_exit" -ne 0 ]; then
    echo "⚠ Failed to reach the Mintlify API (curl exit code $curl_exit, attempt $attempt, ${elapsed}s elapsed)"
    continue
  fi

  poll_http_code=$(echo "$poll_response" | tail -n1)
  response=$(echo "$poll_response" | sed '$d')

  if is_rate_limited "$poll_http_code" "$response"; then
    echo ""
    echo "⚠ Mintlify is rate limiting status checks (HTTP $poll_http_code, attempt $attempt, ${elapsed}s elapsed)"
    echo "$response"
    echo "The documentation update was triggered (status ID ${status_id}) but cannot be monitored from here."
    echo "Stopping now so this job does not keep the limit tripped for the next deploy; check the Mintlify dashboard for the result."
    exit 0
  fi

  deployment_status=$(json_field "$response" '.status // ""')
  summary=$(json_field "$response" '.summary // ""')
  commit_sha=$(json_field "$response" '.commit.sha // ""')
  commit_ref=$(json_field "$response" '.commit.ref // ""')

  if [ -z "$deployment_status" ]; then
    echo "⚠ Unable to retrieve status (HTTP $poll_http_code, attempt $attempt, ${elapsed}s elapsed)"
    echo "Response: $response"
  else
    echo "Deployment status: $deployment_status (attempt $attempt, ${elapsed}s elapsed)"
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
done

echo "⚠ Deployment status check timed out after $((poll_max_wait / 60)) minutes"
echo "Last known status:"
echo "$response" | jq . 2>/dev/null || echo "$response"
exit 1
