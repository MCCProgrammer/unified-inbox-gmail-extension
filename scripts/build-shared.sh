#!/usr/bin/env bash
# Builds a copy to share with friends: one OAuth client for everyone.
#   scripts/build-shared.sh <key.pem> <client-id>
# The key fixes the extension ID, so a single redirect URI works on every
# computer; the client ID is built in. Output: dist/unified-inbox-shared-<version>.zip
set -euo pipefail
cd "$(dirname "$0")/.."

KEY=${1:?usage: scripts/build-shared.sh <key.pem> <client-id>}
CLIENT_ID=${2:?usage: scripts/build-shared.sh <key.pem> <client-id>}
[[ $CLIENT_ID =~ ^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$ ]] || { echo "Not an OAuth client ID: $CLIENT_ID"; exit 1; }

PUBLIC_KEY=$(openssl rsa -in "$KEY" -pubout -outform DER 2>/dev/null | base64 | tr -d '\n')
EXTENSION_ID=$(openssl rsa -in "$KEY" -pubout -outform DER 2>/dev/null | shasum -a 256 | head -c 32 | tr '0-9a-f' 'a-p')
VERSION=$(python3 -c "import json;print(json.load(open('manifest.json'))['version'])")
STAGE="dist/shared/unified-inbox"
OUT="dist/unified-inbox-shared-${VERSION}.zip"

rm -rf dist/shared && mkdir -p "$STAGE"
cp -R assets background content popup LICENSE "$STAGE/"
python3 - "$STAGE/manifest.json" "$PUBLIC_KEY" <<'PY'
import json, sys
manifest = json.load(open('manifest.json'))
manifest['key'] = sys.argv[2]
json.dump(manifest, open(sys.argv[1], 'w'), indent=2, ensure_ascii=False)
PY
sed -i.bak "s/^const DEFAULT_CLIENT_ID = '';/const DEFAULT_CLIENT_ID = '${CLIENT_ID}';/" "$STAGE/background/config.js"
rm "$STAGE/background/config.js.bak"
grep -q "DEFAULT_CLIENT_ID = '${CLIENT_ID}'" "$STAGE/background/config.js" || { echo "Could not set the client ID"; exit 1; }

rm -f "$OUT" && (cd dist/shared && zip -qr "../../$OUT" unified-inbox)
echo "✓ $OUT"
echo "  Extension ID: $EXTENSION_ID"
echo "  Redirect URI for the OAuth client: https://$EXTENSION_ID.chromiumapp.org/"
