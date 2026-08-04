#!/bin/bash
# Generate self-signed certificate for local development
# Usage: ./generate-self-signed-cert.sh
# Output: ssl/cert.pem, ssl/key.pem

set -e

DIR="$(cd "$(dirname "$0")" && pwd)/ssl"
mkdir -p "$DIR"

echo "Generating self-signed certificate..."

openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$DIR/key.pem" \
  -out "$DIR/cert.pem" \
  -days 365 \
  -subj "/C=RU/ST=Moscow/L=Moscow/O=Dev/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,DNS:*.localhost,IP:127.0.0.1"

echo ""
echo "Done! Files generated:"
echo "  $DIR/cert.pem"
echo "  $DIR/key.pem"
echo ""
echo "For production: use Let's Encrypt or your CA-issued certificate."
echo "Mount nginx-ssl.conf instead of nginx.conf in docker-compose.yml."
