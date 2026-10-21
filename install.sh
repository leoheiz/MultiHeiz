#!/usr/bin/env bash
# Install or update MultiHeiz from GitHub Releases (AppImage by default; --deb for .deb).
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/leoheiz/MultiHeiz/main/install.sh | bash
#   ./install.sh --api-base http://127.0.0.1:PORT --asset-pattern 'MultiHeiz-*.AppImage'
set -eu

OWNER="leoheiz"
REPO="MultiHeiz"
API_BASE="https://api.github.com"
RELEASE_JSON_URL=""
VERSION=""
FORCE=0
USE_DEB=0
UNINSTALL=0
ASSET_PATTERN=""
PRODUCT_NAME="MultiHeiz"
SUMS_NAME="SHA256SUMS.txt"

usage() {
  cat <<'EOF'
Usage: install.sh [options]
  --api-base URL          GitHub API base (default: https://api.github.com)
  --release-json-url URL  Full URL to a release JSON (for local mocks)
  --version VER           Install tag vVER / VER instead of latest
  --deb                   Prefer .deb (apt/dpkg); default is AppImage to ~/.local
  --force                 Reinstall even if the same version is present
  --uninstall             Remove AppImage install (or apt remove multiheiz for --deb)
  --asset-pattern GLOB    Override asset name pattern
  --product-name NAME     Name used in messages (default MultiHeiz)
  -h, --help              Show help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --api-base) API_BASE="$2"; shift 2 ;;
    --release-json-url) RELEASE_JSON_URL="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --deb) USE_DEB=1; shift ;;
    --force) FORCE=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --asset-pattern) ASSET_PATTERN="$2"; shift 2 ;;
    --product-name) PRODUCT_NAME="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

have_cmd() { command -v "$1" >/dev/null 2>&1; }

http_get() {
  # $1=url $2=outfile (optional)
  local url="$1"
  local out="${2:-}"
  if have_cmd curl; then
    if [ -n "$out" ]; then
      curl -fsSL -A "MultiHeiz-install.sh" -o "$out" "$url"
    else
      curl -fsSL -A "MultiHeiz-install.sh" "$url"
    fi
  elif have_cmd wget; then
    if [ -n "$out" ]; then
      wget -q -O "$out" --user-agent="MultiHeiz-install.sh" "$url"
    else
      wget -q -O - --user-agent="MultiHeiz-install.sh" "$url"
    fi
  else
    echo "ERRO: precisa de curl ou wget" >&2
    exit 1
  fi
}

json_field() {
  # very small JSON string field extractor: json_field <json> <key>
  local json="$1" key="$2"
  if have_cmd jq; then
    printf '%s' "$json" | jq -r --arg k "$key" 'if type=="object" then .[$k] // empty else empty end'
    return 0
  fi
  printf '%s' "$json" | sed -n "s/.*\"$key\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p" | head -n1
}

json_asset_url() {
  # Find browser_download_url for asset whose name matches pattern (shell glob).
  local json="$1" pattern="$2"
  local n u
  if have_cmd jq; then
    while IFS=$'\t' read -r n u; do
      case "$n" in
        $pattern) printf '%s\n' "$u"; return 0 ;;
      esac
    done <<EOF
$(printf '%s' "$json" | jq -r '.assets[]? | "\(.name)\t\(.browser_download_url)"')
EOF
  fi
  local names urls i
  names=$(printf '%s' "$json" | grep -o '"name"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"\([^"]*\)"$/\1/')
  urls=$(printf '%s' "$json" | grep -o '"browser_download_url"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"\([^"]*\)"$/\1/')
  i=0
  while IFS= read -r n; do
    i=$((i + 1))
    u=$(printf '%s\n' "$urls" | sed -n "${i}p")
    case "$n" in
      $pattern) printf '%s\n' "$u"; return 0 ;;
    esac
  done <<EOF
$names
EOF
  return 1
}

json_asset_name_for_url() {
  local json="$1" want_url="$2"
  if have_cmd jq; then
    printf '%s' "$json" | jq -r --arg u "$want_url" '.assets[]? | select(.browser_download_url==$u) | .name' | head -n1
    return 0
  fi
  local names urls i n u
  names=$(printf '%s' "$json" | grep -o '"name"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"\([^"]*\)"$/\1/')
  urls=$(printf '%s' "$json" | grep -o '"browser_download_url"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"\([^"]*\)"$/\1/')
  i=0
  while IFS= read -r n; do
    i=$((i + 1))
    u=$(printf '%s\n' "$urls" | sed -n "${i}p")
    if [ "$u" = "$want_url" ]; then printf '%s\n' "$n"; return 0; fi
  done <<EOF
$names
EOF
}

sha256_file() {
  if have_cmd sha256sum; then
    sha256sum "$1" | awk '{print $1}'
  elif have_cmd shasum; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    echo "ERRO: precisa de sha256sum ou shasum" >&2
    exit 1
  fi
}

compare_semver() {
  # echo -1/0/1 for a<b / a==b / a>b
  local a="$1" b="$2"
  local IFS=.
  # shellcheck disable=SC2086
  set -- $a
  local a1=${1:-0} a2=${2:-0} a3=${3:-0}
  # shellcheck disable=SC2086
  set -- $b
  local b1=${1:-0} b2=${2:-0} b3=${3:-0}
  [ "$a1" -lt "$b1" ] && { echo -1; return; }
  [ "$a1" -gt "$b1" ] && { echo 1; return; }
  [ "$a2" -lt "$b2" ] && { echo -1; return; }
  [ "$a2" -gt "$b2" ] && { echo 1; return; }
  [ "$a3" -lt "$b3" ] && { echo -1; return; }
  [ "$a3" -gt "$b3" ] && { echo 1; return; }
  echo 0
}

LOCAL_BIN="${HOME}/.local/bin"
APPIMAGE_PATH="${LOCAL_BIN}/MultiHeiz.AppImage"
SYMLINK_PATH="${LOCAL_BIN}/multiheiz"
ICON_PATH="${HOME}/.local/share/icons/hicolor/512x512/apps/multiheiz.png"
DESKTOP_PATH="${HOME}/.local/share/applications/multiheiz.desktop"
VERSION_FILE="${LOCAL_BIN}/.multiheiz-version"

uninstall_appimage() {
  rm -f "$APPIMAGE_PATH" "$SYMLINK_PATH" "$DESKTOP_PATH" "$VERSION_FILE"
  # keep icon (harmless); remove if present
  rm -f "$ICON_PATH"
  if have_cmd update-desktop-database; then
    update-desktop-database "${HOME}/.local/share/applications" >/dev/null 2>&1 || true
  fi
  echo "Removido install AppImage de $PRODUCT_NAME."
}

if [ "$UNINSTALL" -eq 1 ]; then
  if [ "$USE_DEB" -eq 1 ] || have_cmd dpkg; then
    if dpkg -l multiheiz >/dev/null 2>&1; then
      sudo apt-get remove -y multiheiz || sudo dpkg -r multiheiz
    fi
  fi
  uninstall_appimage
  exit 0
fi

if [ -z "$ASSET_PATTERN" ]; then
  if [ "$USE_DEB" -eq 1 ]; then
    ASSET_PATTERN='multiheiz_*_amd64.deb'
  else
    ASSET_PATTERN='MultiHeiz-*.AppImage'
  fi
fi

if [ -n "$RELEASE_JSON_URL" ]; then
  JSON=$(http_get "$RELEASE_JSON_URL")
elif [ -n "$VERSION" ]; then
  tag="$VERSION"
  case "$tag" in v*) ;; *) tag="v$tag" ;; esac
  JSON=$(http_get "$API_BASE/repos/$OWNER/$REPO/releases/tags/$tag")
else
  JSON=$(http_get "$API_BASE/repos/$OWNER/$REPO/releases/latest")
fi

TAG=$(json_field "$JSON" tag_name)
REMOTE_VER=${TAG#v}
echo "Release remoto: $REMOTE_VER"

LOCAL_VER=""
if [ -f "$VERSION_FILE" ]; then
  LOCAL_VER=$(cat "$VERSION_FILE" || true)
elif have_cmd dpkg && dpkg -l multiheiz >/dev/null 2>&1; then
  LOCAL_VER=$(dpkg-query -W -f='${Version}' multiheiz 2>/dev/null || true)
  LOCAL_VER=${LOCAL_VER%%-*}
fi

if [ -n "$LOCAL_VER" ] && [ "$FORCE" -eq 0 ]; then
  cmp=$(compare_semver "$LOCAL_VER" "$REMOTE_VER")
  if [ "$cmp" -eq 0 ]; then
    echo "$PRODUCT_NAME $REMOTE_VER já está instalado. Nada a fazer (use --force)."
    exit 0
  fi
  if [ "$cmp" -gt 0 ]; then
    echo "Versão local ($LOCAL_VER) é mais nova que o release ($REMOTE_VER). Nada a fazer."
    exit 0
  fi
  echo "Atualizando $LOCAL_VER → $REMOTE_VER"
fi

SETUP_URL=$(json_asset_url "$JSON" "$ASSET_PATTERN" || true)
if [ -z "${SETUP_URL:-}" ]; then
  echo "ERRO: asset '$ASSET_PATTERN' não encontrado no release $TAG" >&2
  exit 1
fi
SETUP_NAME=$(json_asset_name_for_url "$JSON" "$SETUP_URL")
[ -n "$SETUP_NAME" ] || SETUP_NAME=$(basename "$SETUP_URL")

TMPDIR=${TMPDIR:-/tmp}
WORK=$(mktemp -d "$TMPDIR/mh-install.XXXXXX")
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

SETUP_PATH="$WORK/$SETUP_NAME"
echo "Baixando $SETUP_NAME..."
http_get "$SETUP_URL" "$SETUP_PATH"

SUMS_URL=$(json_asset_url "$JSON" "$SUMS_NAME" || true)
if [ -n "${SUMS_URL:-}" ]; then
  echo "Baixando $SUMS_NAME..."
  http_get "$SUMS_URL" "$WORK/$SUMS_NAME"
  EXPECT=$(grep -E "^[A-Fa-f0-9]{64}[[:space:]]+\*?${SETUP_NAME}\$" "$WORK/$SUMS_NAME" | awk '{print tolower($1)}' | head -n1 || true)
  if [ -z "$EXPECT" ]; then
    echo "ERRO: $SUMS_NAME sem entrada para $SETUP_NAME" >&2
    exit 1
  fi
  ACTUAL=$(sha256_file "$SETUP_PATH")
  if [ "$ACTUAL" != "$EXPECT" ]; then
    echo "ERRO: SHA256 não confere para $SETUP_NAME" >&2
    echo "  esperado: $EXPECT" >&2
    echo "  obtido:   $ACTUAL" >&2
    exit 1
  fi
  echo "SHA256 OK ($ACTUAL)"
else
  echo "AVISO: release sem $SUMS_NAME — pulando verificação de integridade."
fi

if [ "$USE_DEB" -eq 1 ]; then
  if ! have_cmd dpkg; then
    echo "ERRO: dpkg/apt indisponível; use AppImage (sem --deb)" >&2
    exit 1
  fi
  echo "Instalando .deb..."
  sudo apt-get install -y "$SETUP_PATH" || sudo dpkg -i "$SETUP_PATH"
  echo "Instalado: $PRODUCT_NAME $REMOTE_VER (.deb)"
  exit 0
fi

mkdir -p "$LOCAL_BIN" "$(dirname "$ICON_PATH")" "$(dirname "$DESKTOP_PATH")"
cp -f "$SETUP_PATH" "$APPIMAGE_PATH"
chmod +x "$APPIMAGE_PATH"
ln -sfn "$APPIMAGE_PATH" "$SYMLINK_PATH"
printf '%s\n' "$REMOTE_VER" >"$VERSION_FILE"

# Icon: try to extract from AppImage if possible; else skip (desktop still works)
if [ ! -f "$ICON_PATH" ]; then
  # placeholder: many AppImages embed icon; extraction is optional
  :
fi

cat >"$DESKTOP_PATH" <<EOF
[Desktop Entry]
Type=Application
Name=MultiHeiz
Comment=Navegador multi-janela com painéis e sessões independentes
Exec=$APPIMAGE_PATH
Icon=multiheiz
Terminal=false
Categories=Network;WebBrowser;
StartupWMClass=multiheiz
MimeType=x-scheme-handler/http;x-scheme-handler/https;
EOF

if have_cmd update-desktop-database; then
  update-desktop-database "${HOME}/.local/share/applications" >/dev/null 2>&1 || true
fi

echo "Instalado: $PRODUCT_NAME $REMOTE_VER → $APPIMAGE_PATH (symlink $SYMLINK_PATH)"
