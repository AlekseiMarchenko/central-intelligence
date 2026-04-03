#!/bin/sh
# CI Local Pro — install script
# Usage: curl -fsSL https://centralintelligence.online/install.sh | sh
set -e

VERSION="0.1.0"
REPO="AlekseiMarchenko/ci-local-pro"
INSTALL_DIR="$HOME/.ci-local-pro"
BIN_LINK="/usr/local/bin/ci"

echo ""
echo "  🧠 CI Local Pro v${VERSION}"
echo "  Cross-tool memory dashboard"
echo ""

# Check Node.js
if ! command -v node >/dev/null 2>&1; then
  echo "  ❌ Node.js is required but not installed."
  echo "     Install it: https://nodejs.org or brew install node"
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ] 2>/dev/null; then
  echo "  ❌ Node.js 18+ required (you have $(node -v))"
  exit 1
fi

echo "  ✓ Node.js $(node -v)"

# Download
echo "  → Downloading..."
TARBALL_URL="https://github.com/${REPO}/releases/download/v${VERSION}/ci-local-pro-v${VERSION}.tar.gz"

# Try GitHub release first, fall back to git clone
if command -v curl >/dev/null 2>&1; then
  if curl -fsSL --head "$TARBALL_URL" >/dev/null 2>&1; then
    mkdir -p "$INSTALL_DIR"
    curl -fsSL "$TARBALL_URL" | tar xz -C "$INSTALL_DIR" --strip-components=1
  else
    echo "  → Release not found, cloning from GitHub..."
    if command -v git >/dev/null 2>&1; then
      rm -rf "$INSTALL_DIR"
      git clone --depth 1 "https://github.com/${REPO}.git" "$INSTALL_DIR" 2>/dev/null || {
        echo "  ❌ Failed to clone. The repo may be private."
        echo "     Contact: https://centralintelligence.online for access."
        exit 1
      }
    else
      echo "  ❌ git is required when release tarball is unavailable."
      exit 1
    fi
  fi
else
  echo "  ❌ curl is required."
  exit 1
fi

# Install dependencies
echo "  → Installing dependencies..."
cd "$INSTALL_DIR"
npm install --production --silent 2>/dev/null || npm install --omit=dev --silent

# Create launcher script
mkdir -p "$(dirname "$BIN_LINK")" 2>/dev/null || true
cat > "$INSTALL_DIR/ci-launcher.sh" << 'LAUNCHER'
#!/bin/sh
exec node --import tsx "$HOME/.ci-local-pro/src/cli.ts" "$@"
LAUNCHER
chmod +x "$INSTALL_DIR/ci-launcher.sh"

# Link to PATH
if [ -w "$(dirname "$BIN_LINK")" ]; then
  ln -sf "$INSTALL_DIR/ci-launcher.sh" "$BIN_LINK"
  echo "  ✓ Installed: ci (in $BIN_LINK)"
else
  # Try with sudo
  echo "  → Need permission to install to $BIN_LINK"
  sudo ln -sf "$INSTALL_DIR/ci-launcher.sh" "$BIN_LINK" 2>/dev/null || {
    # Fall back to user bin
    USER_BIN="$HOME/.local/bin"
    mkdir -p "$USER_BIN"
    ln -sf "$INSTALL_DIR/ci-launcher.sh" "$USER_BIN/ci"
    echo "  ✓ Installed: ci (in $USER_BIN)"
    echo "  → Add to PATH if needed: export PATH=\"$USER_BIN:\$PATH\""
  }
fi

echo ""
echo "  ✅ CI Local Pro installed!"
echo ""
echo "  Run:  ci dashboard"
echo "  Open: http://localhost:3141"
echo ""
echo "  Your AI memories are waiting."
echo ""
