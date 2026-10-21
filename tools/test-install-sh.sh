#!/usr/bin/env bash
# Mock-server test for install.sh (Linux / WSL / Git Bash).
# SKIP (exit 0) if python3 is missing.
set -eu

if ! command -v python3 >/dev/null 2>&1; then
  echo "SKIP: python3 indisponível"
  exit 0
fi

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
WORK=$(mktemp -d)
MOCK_PID=""
cleanup() {
  if [ -n "${MOCK_PID:-}" ]; then
    kill "$MOCK_PID" 2>/dev/null || true
    wait "$MOCK_PID" 2>/dev/null || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

mkdir -p "$WORK/assets" "$WORK/shim" "$WORK/home"

FAKE_APP="MultiHeiz-1.3.0.AppImage"
printf 'FAKE-APPIMAGE' >"$WORK/assets/$FAKE_APP"
if command -v sha256sum >/dev/null 2>&1; then
  HASH=$(sha256sum "$WORK/assets/$FAKE_APP" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  HASH=$(shasum -a 256 "$WORK/assets/$FAKE_APP" | awk '{print $1}')
else
  echo "SKIP: sha256sum/shasum indisponível"
  exit 0
fi
printf '%s  %s\n' "$HASH" "$FAKE_APP" >"$WORK/assets/SHA256SUMS.txt"
# 64 hex zeros = intentional mismatch
BAD_HASH="0000000000000000000000000000000000000000000000000000000000000000"
printf '%s  %s\n' "$BAD_HASH" "$FAKE_APP" >"$WORK/assets/SHA256SUMS-BAD.txt"

APT_LOG="$WORK/apt-calls.log"
: >"$APT_LOG"

# PATH shims: simulate dpkg package installed; record apt-get / dpkg -r
cat >"$WORK/shim/dpkg-query" <<'EOF'
#!/usr/bin/env bash
set -eu
# dpkg-query -W -f='${Status}' multiheiz
# Git Bash may pass -f=${Status} as one argv; accept both forms.
fmt=""
while [ $# -gt 0 ]; do
  case "$1" in
    -W) shift ;;
    -f=*|--showformat=*) fmt="${1#*=}"; shift ;;
    -f|--showformat) fmt="$2"; shift 2 ;;
    multiheiz) shift ;;
    *) shift ;;
  esac
done
case "$fmt" in
  *Status*) printf '%s\n' "install ok installed" ;;
  *Version*) printf '%s\n' "1.3.0" ;;
  *) printf '%s\n' "1.3.0" ;;
esac
EOF

cat >"$WORK/shim/dpkg" <<EOF
#!/usr/bin/env bash
set -eu
# Record remove (-r); otherwise pretend package is listed.
for a in "\$@"; do
  if [ "\$a" = "-r" ] || [ "\$a" = "--remove" ]; then
    echo "dpkg \$*" >>"$APT_LOG"
    exit 0
  fi
done
# dpkg -l multiheiz → success (legacy callers); Status still via dpkg-query
exit 0
EOF

cat >"$WORK/shim/apt-get" <<EOF
#!/usr/bin/env bash
set -eu
echo "apt-get \$*" >>"$APT_LOG"
exit 0
EOF

cat >"$WORK/shim/sudo" <<'EOF'
#!/usr/bin/env bash
set -eu
# Drop privilege elevation in tests; run the rest of the command.
exec "$@"
EOF

chmod +x "$WORK/shim/dpkg-query" "$WORK/shim/dpkg" "$WORK/shim/apt-get" "$WORK/shim/sudo"
export PATH="$WORK/shim:$PATH"

# Free port
PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
PREFIX="http://127.0.0.1:${PORT}/"

cat >"$WORK/assets/release.json" <<EOF
{
  "tag_name": "v1.3.0",
  "assets": [
    {"name": "$FAKE_APP", "browser_download_url": "${PREFIX}assets/$FAKE_APP"},
    {"name": "SHA256SUMS.txt", "browser_download_url": "${PREFIX}assets/SHA256SUMS.txt"}
  ]
}
EOF
cat >"$WORK/assets/release-bad.json" <<EOF
{
  "tag_name": "v1.3.0",
  "assets": [
    {"name": "$FAKE_APP", "browser_download_url": "${PREFIX}assets/$FAKE_APP"},
    {"name": "SHA256SUMS.txt", "browser_download_url": "${PREFIX}assets/SHA256SUMS-BAD.txt"}
  ]
}
EOF

# Serve WORK so /assets/... maps to WORK/assets/...
python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$WORK" >/dev/null 2>&1 &
MOCK_PID=$!
sleep 0.4

# Wait until server is up
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if command -v curl >/dev/null 2>&1; then
    curl -fsS "${PREFIX}assets/release.json" >/dev/null 2>&1 && break
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O /dev/null "${PREFIX}assets/release.json" 2>/dev/null && break
  else
    sleep 0.2
    break
  fi
  sleep 0.2
done

export HOME="$WORK/home"
export XDG_CONFIG_HOME="$HOME/.config"
unset XDG_DATA_HOME || true

fail() { echo "FAIL: $*" >&2; exit 1; }

echo "==> install AppImage even with fake deb present"
out=$(bash "$ROOT/install.sh" --release-json-url "${PREFIX}assets/release.json")
echo "$out" | grep -qi 'Nota:.*\.deb' || fail "expected one-line note about .deb"
# On Git Bash/NTFS, chmod +x and ln -s may not yield -x / real symlinks; require files exist.
test -f "$HOME/.local/bin/MultiHeiz.AppImage" || fail "AppImage missing"
test -e "$HOME/.local/bin/multiheiz" || fail "multiheiz launcher missing"
test -f "$HOME/.local/share/applications/multiheiz.desktop" || fail "desktop missing"
test -f "$HOME/.local/bin/.multiheiz-version" || fail "version file missing"

echo "==> same version no-op"
out=$(bash "$ROOT/install.sh" --release-json-url "${PREFIX}assets/release.json")
echo "$out" | grep -qi 'já está instalado\|Nada a fazer' || fail "expected already-installed message"

echo "==> --uninstall removes AppImage only (no apt/dpkg -r)"
: >"$APT_LOG"
bash "$ROOT/install.sh" --uninstall
test ! -e "$HOME/.local/bin/MultiHeiz.AppImage" || fail "AppImage still present"
test ! -e "$HOME/.local/bin/multiheiz" || fail "symlink still present"
test ! -e "$HOME/.local/share/applications/multiheiz.desktop" || fail "desktop still present"
if grep -E 'apt-get|dpkg .*-r' "$APT_LOG" >/dev/null 2>&1; then
  fail "unexpected apt-get/dpkg -r on --uninstall: $(cat "$APT_LOG")"
fi

echo "==> --uninstall --deb records apt-get/dpkg remove"
: >"$APT_LOG"
bash "$ROOT/install.sh" --uninstall --deb
if ! grep -E 'apt-get remove|dpkg .*-r' "$APT_LOG" >/dev/null 2>&1; then
  fail "expected apt-get/dpkg -r on --uninstall --deb; log=$(cat "$APT_LOG")"
fi

echo "==> reinstall then SHA mismatch fails"
bash "$ROOT/install.sh" --release-json-url "${PREFIX}assets/release.json" >/dev/null
set +e
bash "$ROOT/install.sh" --release-json-url "${PREFIX}assets/release-bad.json" --force >/dev/null 2>&1
code=$?
set -e
test "$code" -ne 0 || fail "expected non-zero on SHA mismatch"

echo "PASS: test-install-sh"
