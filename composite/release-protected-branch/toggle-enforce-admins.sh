#!/bin/bash
#
# Toggle the "Include administrators" (enforce_admins) branch protection setting
# on a branch, so a release commit can be pushed to it and the protection then
# restored.
#
# Replaces benjefferies/branch-protection-bot, which is unmaintained (last
# commit Feb 2024) and whose Docker image no longer builds: it is pinned to
# python:3.12.0-slim-bullseye, and Debian 11 reaching EOL made its
# `apt-get update` fail with exit 100. See PLAT-360.
#
# Usage: toggle-enforce-admins.sh enable|disable
# Requires: GITHUB_TOKEN, REPO (as owner/name), BRANCH

set -e

ACTION="${1:?usage: toggle-enforce-admins.sh enable|disable}"
: "${GITHUB_TOKEN:?GITHUB_TOKEN is not set}"
: "${REPO:?REPO is not set}"
: "${BRANCH:?BRANCH is not set}"

case "$ACTION" in
  enable) METHOD=POST ;;
  disable) METHOD=DELETE ;;
  *)
    echo "::error::Unknown action '$ACTION' (expected 'enable' or 'disable')"
    exit 1
    ;;
esac

stderr_file=$(mktemp)
trap 'rm -f "$stderr_file"' EXIT

# Fail loudly if the branch itself cannot be read, so that a mistyped `branch`
# input is not mistaken below for "no protection configured".
if ! gh api "repos/$REPO/branches/$BRANCH" --silent 2>"$stderr_file"; then
  echo "::error::Could not read '$REPO' branch '$BRANCH'."
  cat "$stderr_file" >&2
  exit 1
fi

# Look up classic branch protection, capturing the HTTP status so that a genuine
# 404 can be told apart from an auth, rate-limit or 5xx failure. Only the 404
# means "this branch has no classic protection" and is safe to skip; skipping on
# any other failure would be dangerous, because a silent skip on the re-enable
# step would leave the branch unprotected.
protection_status=$(
  gh api "repos/$REPO/branches/$BRANCH/protection" --include --silent 2>"$stderr_file" |
    sed -n '1s#^HTTP/[0-9.]\{1,\} \([0-9]\{3\}\).*#\1#p'
)

case "$protection_status" in
  200)
    ;;
  404)
    # Matches the old action's behaviour, so repos with no classic protection on
    # their release branch still release successfully. Note that this endpoint
    # also 404s for a token without admin on the repo.
    echo "Branch '$BRANCH' has no classic branch protection, or the token cannot read it. Skipping."
    exit 0
    ;;
  "")
    echo "::error::No HTTP response when reading branch protection for '$REPO' branch '$BRANCH' (network or TLS failure)."
    cat "$stderr_file" >&2
    exit 1
    ;;
  *)
    echo "::error::Could not read branch protection for '$REPO' branch '$BRANCH' (HTTP $protection_status)."
    cat "$stderr_file" >&2
    exit 1
    ;;
esac

# Retry with the same exponential back-off the old action used, to ride out
# transient API failures while protection is being toggled.
for attempt in 0 1 2 3 4; do
  if [ "$attempt" -gt 0 ]; then
    backoff=$((attempt * attempt))
    echo "Retrying in ${backoff}s..."
    sleep "$backoff"
  fi

  if gh api -X "$METHOD" "repos/$REPO/branches/$BRANCH/protection/enforce_admins" --silent; then
    echo "enforce_admins ${ACTION}d on '$BRANCH'."
    exit 0
  fi

  echo "Failed to $ACTION enforce_admins on '$BRANCH' (attempt $((attempt + 1))/5)."
done

echo "::error::Failed to $ACTION enforce_admins on '$BRANCH' after 5 attempts."
exit 1
