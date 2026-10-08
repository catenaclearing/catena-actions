FROM python:3.13-slim-bookworm

# Pinned to the boto3 the tests run against (poetry.lock), so what ships is what was tested.
ENV BOTO3_VERSION=1.35.49 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN pip install --no-cache-dir "boto3==${BOTO3_VERSION}"

WORKDIR /app
COPY src/ /app/
COPY entrypoint.sh post.sh /

RUN chmod +x /entrypoint.sh /post.sh

# GitHub Actions container actions run as root by design so the entrypoint can read the
# mounted event payload and write the step output files. See GitHub's Dockerfile support
# docs, which recommend against setting USER for container actions.
# nosemgrep: dockerfile.security.missing-user-entrypoint.missing-user-entrypoint
ENTRYPOINT ["/entrypoint.sh"]
