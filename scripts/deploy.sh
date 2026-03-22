#!/bin/bash
set -euo pipefail

# Central Intelligence — Deploy Script

BOLD='\033[1m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
RED='\033[0;31m'
DIM='\033[2m'
RESET='\033[0m'

APP_NAME="${CI_APP_NAME:-central-intelligence-api}"

echo -e "${BOLD}"
echo "  Central Intelligence — Deploy"
echo -e "${RESET}"

# --- Pre-flight checks ---
echo -e "${BOLD}Pre-flight checks...${RESET}"

# Check flyctl
if ! command -v flyctl &> /dev/null; then
  echo -e "${RED}✗ flyctl not installed${RESET}"
  exit 1
fi
echo -e "${GREEN}✓${RESET} flyctl installed"

# Check auth
if ! flyctl auth whoami &> /dev/null; then
  echo -e "${RED}✗ Not logged in to Fly.io${RESET}"
  exit 1
fi
echo -e "${GREEN}✓${RESET} Fly.io authenticated"

# Check app exists
if ! flyctl apps list | grep -q "$APP_NAME"; then
  echo -e "${RED}✗ App '$APP_NAME' not found. Run scripts/setup.sh first.${RESET}"
  exit 1
fi
echo -e "${GREEN}✓${RESET} App '$APP_NAME' exists"

# Check secrets
if ! flyctl secrets list --app "$APP_NAME" | grep -q "OPENAI_API_KEY"; then
  echo -e "${RED}✗ OPENAI_API_KEY not set. Run: flyctl secrets set OPENAI_API_KEY=sk-...${RESET}"
  exit 1
fi
echo -e "${GREEN}✓${RESET} Secrets configured"

# --- Deploy ---
echo ""
echo -e "${BOLD}Deploying...${RESET}"
flyctl deploy --app "$APP_NAME" --wait-timeout 120

# --- Verify ---
echo ""
echo -e "${BOLD}Verifying deployment...${RESET}"
HEALTH_URL="https://$APP_NAME.fly.dev/health"

for i in 1 2 3; do
  sleep 3
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$HEALTH_URL" 2>/dev/null || echo "000")
  if [ "$STATUS" = "200" ]; then
    echo -e "${GREEN}✓ Health check passed${RESET}"
    break
  fi
  if [ "$i" = "3" ]; then
    echo -e "${RED}✗ Health check failed (HTTP $STATUS)${RESET}"
    echo -e "${DIM}Check logs: flyctl logs --app $APP_NAME${RESET}"
    exit 1
  fi
  echo -e "${DIM}Waiting for app to start... (attempt $i/3)${RESET}"
done

# --- Summary ---
echo ""
echo -e "${GREEN}${BOLD}Deployed successfully!${RESET}"
echo ""
echo -e "${CYAN}API:${RESET}    https://$APP_NAME.fly.dev"
echo -e "${CYAN}Health:${RESET} https://$APP_NAME.fly.dev/health"
echo ""
echo -e "${DIM}Create your first API key:${RESET}"
echo -e "  ${CYAN}curl -X POST https://$APP_NAME.fly.dev/keys -H 'Content-Type: application/json' -d '{\"name\": \"my-key\"}'${RESET}"
echo ""
