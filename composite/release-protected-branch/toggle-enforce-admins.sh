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

# Match the old action's behaviour: an unprotected branch is a no-op rather than
# a failure, so repos with no protection rules on their release branch still
# release successfully.
if ! gh api "repos/$REPO/branches/$BRANCH/protection" --silent 2>/dev/null; then
  echo "Branch '$BRANCH' has no protection rules. Skipping."
  exit 0
fi

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
