FROM python:3.13-slim-bookworm

# Set the version of gh-token to install
ENV GHTOKEN_VERSION=v2.0.2

# Install Github Cli
RUN apt-get update -y \
    && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    gh \
    git \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir "commitizen>=3.12.0,<4.0.0"

COPY entrypoint.sh /entrypoint.sh

RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
