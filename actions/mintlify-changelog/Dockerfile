FROM python:3.13-slim-bookworm

# Install dependencies
RUN apt-get update -y \
    && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    jq \
    && rm -rf /var/lib/apt/lists/*

# Install oasdiff for OpenAPI 3.1 diff support
# Pinned at or above 1.32.0: earlier builds model exclusiveMinimum as OpenAPI
# 3.0's boolean and refuse any 3.1 spec that uses its numeric form (ref DP-622).
ARG OASDIFF_VERSION=1.32.0
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
RUN curl -sSfL "https://github.com/Tufin/oasdiff/releases/download/v${OASDIFF_VERSION}/oasdiff_${OASDIFF_VERSION}_linux_amd64.tar.gz" \
    | tar -xz -C /usr/local/bin oasdiff \
    && chmod +x /usr/local/bin/oasdiff

COPY entrypoint.sh /entrypoint.sh
COPY changelog-instructions.md /changelog-instructions.md

RUN chmod +x /entrypoint.sh

# GitHub Actions container actions run as root by design so the entrypoint can
# access the mounted workspace and $HOME. See GitHub's Dockerfile support docs,
# which recommend against setting USER for container actions.
# nosemgrep: dockerfile.security.missing-user-entrypoint.missing-user-entrypoint
ENTRYPOINT ["/entrypoint.sh"]
