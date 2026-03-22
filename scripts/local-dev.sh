#!/bin/bash
set -euo pipefail

# Central Intelligence — Local Development Quick Start
# Runs everything needed for local development

BOLD='\033[1m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
RED='\033[0;31m'
DIM='\033[2m'
RESET='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$SCRIPT_DIR/.."

echo -e "${BOLD}"
echo "  Central Intelligence — Local Development Setup"
echo -e "${RESET}"

# --- Check prerequisites ---
echo -e "${BOLD}Checking prerequisites...${RESET}"

check_cmd() {
  if command -v "$1" &> /dev/null; then
    echo -e "${GREEN}✓${RESET} $1"
    return 0
  else
    echo -e "${RED}✗${RESET} $1 not found"
    return 1
  fi
}

MISSING=0
check_cmd node || MISSING=1
check_cmd npm || MISSING=1
check_cmd psql || MISSING=1

if [ "$MISSING" = "1" ]; then
  echo ""
  echo "Install missing dependencies:"
  echo "  Node.js: https://nodejs.org (v20+)"
  echo "  PostgreSQL: brew install postgresql@16 pgvector"
  exit 1
fi

# --- Check .env ---
echo ""
if [ ! -f "$PROJECT_DIR/.env" ]; then
  echo -e "${CYAN}Creating .env from template...${RESET}"
  cp "$PROJECT_DIR/.env.example" "$PROJECT_DIR/.env"
  echo -e "${DIM}Edit .env to add your OPENAI_API_KEY${RESET}"

  if [ -z "${OPENAI_API_KEY:-}" ]; then
    echo ""
    echo -e "${RED}OPENAI_API_KEY not set.${RESET}"
    echo "Add it to .env or export it:"
    echo "  export OPENAI_API_KEY=sk-..."
    exit 1
  fi
fi

# --- Install dependencies ---
echo ""
echo -e "${BOLD}Installing dependencies...${RESET}"
cd "$PROJECT_DIR"
npm install
echo -e "${GREEN}✓ Dependencies installed${RESET}"

# --- Set up database ---
echo ""
echo -e "${BOLD}Setting up database...${RESET}"
"$SCRIPT_DIR/db-setup.sh" local

# --- Start the API ---
echo ""
echo -e "${GREEN}${BOLD}Ready! Starting API server...${RESET}"
echo ""
echo -e "${DIM}API will be available at:${RESET} ${CYAN}http://localhost:3141${RESET}"
echo -e "${DIM}Create an API key:${RESET}       ${CYAN}curl -X POST http://localhost:3141/keys -H 'Content-Type: application/json' -d '{\"name\": \"dev\"}'${RESET}"
echo ""

npm run dev:api
