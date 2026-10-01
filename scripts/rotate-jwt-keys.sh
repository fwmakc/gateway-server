#!/bin/sh
# Rotate the stack's RS256 JWT signing pair (zero-downtime procedure:
# docs/secret-rotation.md). Run from the gateway-server directory.
#
#   ./scripts/rotate-jwt-keys.sh
#
# Keeps the retired public key in the `auth_keys` volume as
# jwt-public-retired.pem, then generates a fresh pair. After this:
#   1. set JWT_PREVIOUS_PUBLIC_KEY_PATHS=/keys/jwt-public-retired.pem in .env
#   2. docker compose up -d auth-server
#   3. after the overlap window (access-token TTL is enough) remove the env
#      and run this script again with --cleanup to drop the retired file.
set -e

case "$1" in
  --cleanup)
    docker compose run --rm --entrypoint sh auth-keys -c '
      if [ -f /keys/jwt-public-retired.pem ]; then
        rm /keys/jwt-public-retired.pem
        echo "Retired key removed. Remove JWT_PREVIOUS_PUBLIC_KEY_PATHS from .env and: docker compose up -d auth-server"
      else
        echo "Nothing to clean up (no jwt-public-retired.pem in the volume)"
      fi'
    exit 0
    ;;
esac

docker compose run --rm --entrypoint sh auth-keys -c '
  if [ ! -f /keys/jwt-private.pem ] || [ ! -f /keys/jwt-public.pem ]; then
    echo "No existing key pair in the volume — let the auth-keys job generate it on first boot instead."
    exit 1
  fi
  if [ -f /keys/jwt-public-retired.pem ]; then
    echo "A rotation is already in progress (jwt-public-retired.pem exists)."
    echo "Finish it first: after the overlap window remove JWT_PREVIOUS_PUBLIC_KEY_PATHS from .env, restart auth-server, then run: $0 --cleanup"
    exit 1
  fi
  cp /keys/jwt-public.pem /keys/jwt-public-retired.pem
  node -e "const c=require(\"crypto\"),f=require(\"fs\");const{publicKey,privateKey}=c.generateKeyPairSync(\"rsa\",{modulusLength:2048});f.writeFileSync(\"/keys/jwt-private.pem\",privateKey.export({type:\"pkcs8\",format:\"pem\"}));f.writeFileSync(\"/keys/jwt-public.pem\",publicKey.export({type:\"spki\",format:\"pem\"}));"
  chmod 644 /keys/jwt-private.pem /keys/jwt-public.pem /keys/jwt-public-retired.pem
  echo "New signing pair generated; retired public key saved as jwt-public-retired.pem."
  echo ""
  echo "Next steps:"
  echo "  1. Add to .env:  JWT_PREVIOUS_PUBLIC_KEY_PATHS=/keys/jwt-public-retired.pem"
  echo "  2. docker compose up -d auth-server  (JWKS now lists both keys)"
  echo "  3. After max access-token TTL (default 15m) + a small buffer:"
  echo "     remove JWT_PREVIOUS_PUBLIC_KEY_PATHS from .env, docker compose up -d auth-server,"
  echo "     then run: ./scripts/rotate-jwt-keys.sh --cleanup"'
