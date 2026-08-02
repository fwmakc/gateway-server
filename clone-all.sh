#!/usr/bin/env bash
set -euo pipefail

# Clones all microservices as sibling directories for Docker Compose.
# Run this in the directory where you want all services to live.

REPOS=(
    "gateway-server"
    "api-server-toolkit"
    "auth-server"
    "api-server"
    "event-server"
    "message-server"
    "file-server"
    "chat-server"
    "scaffold"
)

BASE="$(cd "$(dirname "$0")" && pwd)"

echo ""
echo "=== Cloning all repositories into $BASE ==="

for repo in "${REPOS[@]}"; do
    if [ -d "$BASE/$repo" ]; then
        echo "  [skip] $repo (already exists)"
    else
        echo "  [clone] $repo"
        git clone "https://github.com/fwmakc/$repo.git" "$BASE/$repo"
    fi
done

echo ""
echo "=== Done ==="
echo "All repositories cloned as sibling directories."
echo ""
echo "Next steps:"
echo "  cd gateway-server"
echo "  cp .env.example .env"
echo "  docker compose up -d --build"
