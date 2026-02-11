FROM python:3.13-slim-bookworm

# Install dependencies
RUN apt-get update -y \
    && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    jq \
    && rm -rf /var/lib/apt/lists/*

# Install oasdiff for OpenAPI 3.1 diff support
ARG OASDIFF_VERSION=1.11.10
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
RUN curl -sSfL "https://github.com/Tufin/oasdiff/releases/download/v${OASDIFF_VERSION}/oasdiff_${OASDIFF_VERSION}_linux_amd64.tar.gz" \
    | tar -xz -C /usr/local/bin oasdiff \
    && chmod +x /usr/local/bin/oasdiff

COPY entrypoint.sh /entrypoint.sh
COPY changelog-instructions.md /changelog-instructions.md

RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
