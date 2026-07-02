FROM python:3.13-slim-bookworm

# Install dependencies
RUN apt-get update -y \
    && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    jq \
    && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /entrypoint.sh

RUN chmod +x /entrypoint.sh

# GitHub Actions container actions run as root by design so the entrypoint can
# access the mounted workspace and $HOME. See GitHub's Dockerfile support docs,
# which recommend against setting USER for container actions.
# nosemgrep: dockerfile.security.missing-user-entrypoint.missing-user-entrypoint
ENTRYPOINT ["/entrypoint.sh"]
