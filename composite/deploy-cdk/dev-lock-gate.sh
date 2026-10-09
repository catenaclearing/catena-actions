#!/bin/bash
# Decide whether this deploy takes the dev lock (PLAT-473): only in the development account, and only for the
# repos listed in DEV_LOCK_REPOS. Writes is_dev_lock=true|false to $GITHUB_OUTPUT.
#
# This runs in every deploy of every repo that uses deploy-cdk, production and management included, so it must
# never fail: any doubt (no aws CLI, no credentials, an unexpected answer) means "no lock".
set +e

repos="${DEV_LOCK_REPOS//[[:space:]]/}"
dev_account="${DEV_LOCK_ACCOUNT_ID//[[:space:]]/}"
enabled=false

if [ -n "$repos" ] && [ -n "$dev_account" ] && [ -n "$GITHUB_REPOSITORY" ]; then
  account="$(aws sts get-caller-identity --query Account --output text 2>/dev/null)"
  account="${account//[[:space:]]/}"
  if [ "$account" = "$dev_account" ]; then
    # Exact match on a whole comma-separated entry; the quoted part is literal, so "catena-platform" does not
    # match "catena-platform-extra" or "someone-else/catena-platform".
    case ",${repos}," in
      *",${GITHUB_REPOSITORY},"*) enabled=true ;;
    esac
  fi
fi

if [ -n "$GITHUB_OUTPUT" ]; then
  echo "is_dev_lock=${enabled}" >> "$GITHUB_OUTPUT"
else
  echo "is_dev_lock=${enabled}"
fi
exit 0
