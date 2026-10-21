#!/usr/bin/env bash
# Mock-server test for install.sh (intended to run on Linux).
# On Windows this script is only syntax-checked (bash -n) if bash is available.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"; [ -n "${MOCK_PID:-}" ] && kill "$MOCK_PID" 2>/dev/null || true' EXIT

# Fake AppImage payload
mkdir -p "$WORK/assets"
FAKE_APP="MultiHeiz-1.3.0.AppImage"
printf 'FAKE-APPIMAGE' >"$WORK/assets/$FAKE_APP"
HASH=$(sha256sum "$WORK/assets/$FAKE_APP" | awk '{print $1}')
printf '%s  %s\n' "$HASH" "$FAKE_APP" >"$WORK/assets/SHA256SUMS.txt"
printf '%s  %s\n' "$(printf '0%.0s' {1..64})" "$FAKE_APP" >"$WORK/assets/SHA256SUMS-BAD.txt"

# Pick free port via node
PORT=$(node -e "const n=require('net').createServer();n.listen(0,'127.0.0.1',()=>{console.log(n.address().port);n.close()})")
PREFIX="http://127.0.0.1:${PORT}/"

cat >"$WORK/latest.json" <<EOF
{
  "tag_name": "v1.3.0",
  "assets": [
    {"name": "$FAKE_APP", "browser_download_url": "${PREFIX}assets/$FAKE_APP"},
    {"name": "SHA256SUMS.txt", "browser_download_url": "${PREFIX}assets/SHA256SUMS.txt"}
  ]
}
EOF
cat >"$WORK/latest-bad.json" <<EOF
{
  "tag_name": "v1.3.0",
  "assets": [
    {"name": "$FAKE_APP", "browser_download_url": "${PREFIX}assets/$FAKE_APP"},
    {"name": "SHA256SUMS.txt", "browser_download_url": "${PREFIX}assets/SHA256SUMS-BAD.txt"}
  ]
}
EOF

node "$ROOT/tools/mock-github-release-server.js" --port "$PORT" --root "$WORK" --latest "$WORK/latest.json" --bad-latest "$WORK/latest-bad.json" &
MOCK_PID=$!
sleep 0.5

HOME_FAKE=$(mktemp -d)
export HOME="$HOME_FAKE"
export XDG_CONFIG_HOME="$HOME_FAKE/.config"

echo "==> install.sh AppImage (mock)"
bash "$ROOT/install.sh" --release-json-url "${PREFIX}releases/latest"
test -x "$HOME/.local/bin/MultiHeiz.AppImage"
test -L "$HOME/.local/bin/multiheiz"
test -f "$HOME/.local/share/applications/multiheiz.desktop"

echo "==> same version no-op"
out=$(bash "$ROOT/install.sh" --release-json-url "${PREFIX}releases/latest" || true)
echo "$out" | grep -qi 'já está instalado\|Nada a fazer'

echo "==> tampered SHA aborts"
set +e
bash "$ROOT/install.sh" --release-json-url "${PREFIX}releases/latest-bad" --force
code=$?
set -e
test "$code" -ne 0

echo "==> uninstall"
bash "$ROOT/install.sh" --uninstall
test ! -e "$HOME/.local/bin/MultiHeiz.AppImage"

echo "PASS: test-install-sh"
