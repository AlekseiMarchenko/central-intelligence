#!/bin/sh
# CI Local Pro — one-command installer
# macOS / Linux: curl -fsSL https://centralintelligence.online/install.sh | sh
# With token:    CI_TOKEN=ghp_xxx curl -fsSL https://centralintelligence.online/install.sh | sh
set -e

VERSION="0.1.0"
REPO="AlekseiMarchenko/ci-local-pro"
INSTALL_DIR="$HOME/.ci-local-pro"
TOKEN="${CI_TOKEN:-}"
GREEN='\033[0;32m'
RED='\033[0;31m'
DIM='\033[2m'
BOLD='\033[1m'
NC='\033[0m'

echo ""
echo "  ${BOLD}🧠 CI Local Pro${NC} v${VERSION}"
echo "  ${DIM}See what your AI actually remembers${NC}"
echo ""

# --- Detect platform ---
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

case "$OS" in
  darwin) PLATFORM="macOS" ;;
  linux)  PLATFORM="Linux" ;;
  *)      echo "  ${RED}❌ Unsupported platform: $OS${NC}"; echo "  Windows: download from https://github.com/${REPO}/releases"; exit 1 ;;
esac

case "$ARCH" in
  x86_64|amd64) ARCH_LABEL="x64" ;;
  arm64|aarch64) ARCH_LABEL="arm64" ;;
  *)             ARCH_LABEL="$ARCH" ;;
esac

echo "  ${DIM}Platform: ${PLATFORM} ${ARCH_LABEL}${NC}"

# --- Check/install Node.js ---
install_node() {
  echo ""
  echo "  ${BOLD}Node.js 18+ is required.${NC}"
  echo ""

  if [ "$OS" = "darwin" ]; then
    # macOS: try brew first, then direct download
    if command -v brew >/dev/null 2>&1; then
      echo "  → Installing Node.js via Homebrew..."
      brew install node
    else
      echo "  → Installing Node.js..."
      curl -fsSL https://nodejs.org/dist/v22.14.0/node-v22.14.0-darwin-${ARCH}.tar.gz -o /tmp/node.tar.gz
      sudo mkdir -p /usr/local/lib/nodejs
      sudo tar xzf /tmp/node.tar.gz -C /usr/local/lib/nodejs
      export PATH="/usr/local/lib/nodejs/node-v22.14.0-darwin-${ARCH}/bin:$PATH"
      rm /tmp/node.tar.gz
      # Add to shell profile
      SHELL_RC="$HOME/.zshrc"
      [ -f "$HOME/.bashrc" ] && SHELL_RC="$HOME/.bashrc"
      echo "export PATH=\"/usr/local/lib/nodejs/node-v22.14.0-darwin-${ARCH}/bin:\$PATH\"" >> "$SHELL_RC"
    fi
  else
    # Linux: use NodeSource
    if command -v apt-get >/dev/null 2>&1; then
      echo "  → Installing Node.js via apt..."
      curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
      sudo apt-get install -y nodejs
    elif command -v dnf >/dev/null 2>&1; then
      echo "  → Installing Node.js via dnf..."
      curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
      sudo dnf install -y nodejs
    else
      echo "  → Installing Node.js via binary..."
      curl -fsSL "https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-${ARCH}.tar.xz" -o /tmp/node.tar.xz
      sudo mkdir -p /usr/local/lib/nodejs
      sudo tar xJf /tmp/node.tar.xz -C /usr/local/lib/nodejs
      export PATH="/usr/local/lib/nodejs/node-v22.14.0-linux-${ARCH}/bin:$PATH"
      rm /tmp/node.tar.xz
      echo "export PATH=\"/usr/local/lib/nodejs/node-v22.14.0-linux-${ARCH}/bin:\$PATH\"" >> "$HOME/.bashrc"
    fi
  fi
}

if command -v node >/dev/null 2>&1; then
  NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_VERSION" -lt 18 ] 2>/dev/null; then
    echo "  ${RED}Node.js is outdated ($(node -v), need 18+)${NC}"
    install_node
  else
    echo "  ${GREEN}✓${NC} Node.js $(node -v)"
  fi
else
  install_node
fi

# Verify Node works now
if ! command -v node >/dev/null 2>&1; then
  echo "  ${RED}❌ Node.js installation failed. Install manually: https://nodejs.org${NC}"
  exit 1
fi
echo "  ${GREEN}✓${NC} Node.js $(node -v)"

# --- Download CI Local Pro ---
echo "  → Downloading CI Local Pro..."

TARBALL_URL="https://github.com/${REPO}/releases/download/v${VERSION}/ci-local-pro-v${VERSION}.tar.gz"
CLONE_URL="https://github.com/${REPO}.git"

rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR"

# Build auth header if token provided
AUTH_HEADER=""
if [ -n "$TOKEN" ]; then
  AUTH_HEADER="Authorization: token ${TOKEN}"
  echo "  ${DIM}Using access token${NC}"
fi

# Try release tarball first
DOWNLOADED=false
if [ -n "$AUTH_HEADER" ]; then
  # Private repo: use GitHub API to get release asset
  ASSET_URL=$(curl -fsSL -H "$AUTH_HEADER" -H "Accept: application/vnd.github.v3+json" \
    "https://api.github.com/repos/${REPO}/releases/tags/v${VERSION}" 2>/dev/null | \
    grep -o '"browser_download_url": *"[^"]*tar.gz"' | head -1 | sed 's/.*": *"//;s/"//')

  if [ -n "$ASSET_URL" ]; then
    curl -fsSL -H "$AUTH_HEADER" -H "Accept: application/octet-stream" \
      -L "$ASSET_URL" | tar xz -C "$INSTALL_DIR" --strip-components=1 2>/dev/null && DOWNLOADED=true
  fi
else
  # Public: try direct download
  if curl -fsSL --head "$TARBALL_URL" >/dev/null 2>&1; then
    curl -fsSL "$TARBALL_URL" | tar xz -C "$INSTALL_DIR" --strip-components=1 2>/dev/null && DOWNLOADED=true
  fi
fi

if [ "$DOWNLOADED" = false ]; then
  echo "  ${DIM}→ Tarball unavailable, trying git clone...${NC}"
  if command -v git >/dev/null 2>&1; then
    if [ -n "$TOKEN" ]; then
      git clone --depth 1 "https://${TOKEN}@github.com/${REPO}.git" "$INSTALL_DIR" 2>/dev/null || {
        echo "  ${RED}❌ Download failed. Check your access token.${NC}"
        exit 1
      }
    else
      git clone --depth 1 "$CLONE_URL" "$INSTALL_DIR" 2>/dev/null || {
        echo "  ${RED}❌ Download failed. Private repo requires access token.${NC}"
        echo ""
        echo "  ${BOLD}Run with token:${NC}"
        echo "  CI_TOKEN=your_github_token curl -fsSL https://centralintelligence.online/install.sh | sh"
        echo ""
        echo "  ${DIM}Get a token: https://github.com/settings/tokens (repo scope)${NC}"
        exit 1
      }
    fi
  else
    echo "  ${RED}❌ git is required.${NC}"
    exit 1
  fi
fi

# --- Install dependencies ---
echo "  → Installing dependencies..."
cd "$INSTALL_DIR"
npm install --omit=dev --silent 2>/dev/null || npm install --production --silent 2>/dev/null

# --- Create launcher ---
cat > "$INSTALL_DIR/ci" << 'LAUNCHER'
#!/bin/sh
DIR="$(cd "$(dirname "$0")" && pwd)"
exec npx --yes tsx "$DIR/src/cli.ts" "$@"
LAUNCHER
chmod +x "$INSTALL_DIR/ci"

# --- Link to PATH ---
BIN_DIR="/usr/local/bin"
if [ ! -w "$BIN_DIR" ]; then
  BIN_DIR="$HOME/.local/bin"
  mkdir -p "$BIN_DIR"
fi

ln -sf "$INSTALL_DIR/ci" "$BIN_DIR/ci" 2>/dev/null || {
  sudo ln -sf "$INSTALL_DIR/ci" "/usr/local/bin/ci" 2>/dev/null || {
    BIN_DIR="$HOME/.local/bin"
    mkdir -p "$BIN_DIR"
    ln -sf "$INSTALL_DIR/ci" "$BIN_DIR/ci"
  }
}

# Check if BIN_DIR is in PATH
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "  ${DIM}Add to your PATH: export PATH=\"$BIN_DIR:\$PATH\"${NC}" ;;
esac

echo ""
echo "  ${GREEN}${BOLD}✅ CI Local Pro installed!${NC}"
echo ""
echo "  ${BOLD}Next:${NC}  ci dashboard"
echo "  ${BOLD}Open:${NC}  http://localhost:3141"
echo ""
echo "  ${DIM}Your AI memories are waiting.${NC}"
echo ""
