#!/bin/bash
# Refuse to deploy over a stack that another repo owns. composite/deploy-cdk runs this right before "CDK Deploy", and,
# for deploys that take the dev lock, also before it builds and publishes assets (PLAT-590), so nothing is published
# for a stack this repo does not own. Exits non-zero to stop the deploy. Reads STACK_NAME, THIS_REPO and
# ENFORCE_OWNERSHIP_TAG from the environment.
set -euo pipefail
# Ownership is tracked by a stack-level tag that the "CDK Deploy" step
# stamps on every deploy. We read it back here and compare it to this repo.
# The tag VALUE is the repo, which is unique per service, so this works even
# though all services are generated from the same template and therefore have
# near-identical resource names (which is why comparing resources or diffs
# would not tell two services apart).
OWNER_TAG="catena:managed-by"
# describe-stacks fails if the stack doesn't exist (safe to create) but ALSO on
# real errors (AccessDenied, throttling, wrong region). Tell them apart: treating
# every failure as "no stack" would silently disable this guard on a transient
# error, so fail closed on anything other than a genuine "does not exist".
ERR_FILE="${RUNNER_TEMP:-/tmp}/deploy-cdk-guard-err.txt"
if ! OWNER=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
    --query "Stacks[0].Tags[?Key=='$OWNER_TAG'].Value | [0]" --output text 2>"$ERR_FILE"); then
  if grep -q "does not exist" "$ERR_FILE"; then
    echo "Stack '$STACK_NAME' does not exist yet. Safe to create."
    exit 0
  fi
  echo "::error::Could not check ownership of stack '$STACK_NAME'; refusing to deploy blindly."
  cat "$ERR_FILE" >&2
  exit 1
fi
# AWS CLI prints the literal "None" when the stack exists but has no such tag.
if [ "$OWNER" = "None" ]; then OWNER=""; fi
if [ -z "$OWNER" ]; then
  if [ "$ENFORCE_OWNERSHIP_TAG" = "true" ]; then
    MSG="Stack '$STACK_NAME' exists but has no '$OWNER_TAG' tag; owner cannot be confirmed."
    MSG="$MSG enforce_ownership_tag is on. Backfill the tag on the stack, then retry."
    echo "::error::$MSG"
    exit 1
  fi
  MSG="Stack '$STACK_NAME' exists but has no '$OWNER_TAG' tag (legacy stack)."
  MSG="$MSG Cannot confirm owner; proceeding. This deploy will stamp it with '$THIS_REPO'."
  echo "::warning::$MSG"
  exit 0
fi
if [ "$OWNER" != "$THIS_REPO" ]; then
  MSG="Stack '$STACK_NAME' already exists and is managed by '$OWNER'."
  MSG="$MSG This deploy is from '$THIS_REPO' - refusing to overwrite another service's stack."
  MSG="$MSG Use a unique stack name in app.py and deploy.yaml."
  echo "::error::$MSG"
  exit 1
fi
echo "Stack '$STACK_NAME' is managed by '$OWNER' (this repo). Safe to update."
