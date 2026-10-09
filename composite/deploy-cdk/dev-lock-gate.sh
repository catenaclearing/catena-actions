#!/bin/bash
# Decide whether this deploy takes the dev lock (PLAT-473): only in the development account, and only for the
# repos listed in DEV_LOCK_REPOS. Writes is_dev_lock=true|false to $GITHUB_OUTPUT, and says why on stdout, so a
# renamed repo or a typo in the list cannot turn the lock off without a trace.
#
# This runs in every deploy of every repo that uses deploy-cdk, production and management included, so it must
# never fail: any doubt (no aws CLI, no credentials, an unexpected answer) means "no lock".
set +e

repos="${DEV_LOCK_REPOS//[[:space:]]/}"
dev_account="${DEV_LOCK_ACCOUNT_ID//[[:space:]]/}"
enabled=false
reason="dev_lock_repos or dev_lock_account_id is blank"

if [ -n "$repos" ] && [ -n "$dev_account" ] && [ -n "$GITHUB_REPOSITORY" ]; then
  account="$(aws sts get-caller-identity --query Account --output text 2>/dev/null)"
  account="${account//[[:space:]]/}"
  if [ -z "$account" ]; then
    reason="could not tell which AWS account these credentials belong to"
  elif [ "$account" != "$dev_account" ]; then
    reason="not the development account"
  else
    # Exact match on a whole comma-separated entry; the quoted part is literal, so "catena-platform" does not
    # match "catena-platform-extra" or "someone-else/catena-platform".
    reason="${GITHUB_REPOSITORY} is not in dev_lock_repos"
    case ",${repos}," in
      *",${GITHUB_REPOSITORY},"*)
        enabled=true
        reason="development account and ${GITHUB_REPOSITORY} is in dev_lock_repos"
        ;;
    esac
  fi
fi

if [ "$enabled" = true ]; then
  echo "dev lock: on (${reason})"
else
  echo "dev lock: off (${reason})"
fi

if [ -n "$GITHUB_OUTPUT" ]; then
  echo "is_dev_lock=${enabled}" >> "$GITHUB_OUTPUT"
else
  echo "is_dev_lock=${enabled}"
fi
exit 0
