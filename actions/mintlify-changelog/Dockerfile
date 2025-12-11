FROM python:3.13-slim-bookworm


# Install dependencies
RUN apt-get update -y \
    && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    jq \
    && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /entrypoint.sh
COPY changelog-instructions.md /changelog-instructions.md

RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
