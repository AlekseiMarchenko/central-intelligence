#!/bin/bash
set -euo pipefail

# Central Intelligence — Infrastructure Setup Script
# Prerequisites: flyctl CLI installed (https://fly.io/docs/flyctl/install/)

BOLD='\033[1m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
DIM='\033[2m'
RESET='\033[0m'

APP_NAME="${CI_APP_NAME:-central-intelligence-api}"
REGION="${CI_REGION:-iad}"
DB_NAME="${CI_DB_NAME:-ci-db}"

echo -e "${BOLD}"
echo "  ╔═══════════════════════════════════════╗"
echo "  ║       CENTRAL INTELLIGENCE            ║"
echo "  ║       Infrastructure Setup            ║"
echo "  ╚═══════════════════════════════════════╝"
echo -e "${RESET}"

# --- Pre-checks ---
if ! command -v flyctl &> /dev/null; then
  echo "flyctl not found. Install it:"
  echo "  curl -L https://fly.io/install.sh | sh"
  exit 1
fi

if ! flyctl auth whoami &> /dev/null; then
  echo "Not logged in to Fly.io. Running login..."
  flyctl auth login
fi

echo -e "${CYAN}Region:${RESET} $REGION"
echo -e "${CYAN}App:${RESET}    $APP_NAME"
echo -e "${CYAN}DB:${RESET}     $DB_NAME"
echo ""

# --- Step 1: Create the app ---
echo -e "${BOLD}[1/5] Creating Fly.io app...${RESET}"
if flyctl apps list | grep -q "$APP_NAME"; then
  echo -e "${DIM}App '$APP_NAME' already exists, skipping.${RESET}"
else
  flyctl apps create "$APP_NAME" --machines
  echo -e "${GREEN}✓ App created${RESET}"
fi

# --- Step 2: Create Postgres cluster ---
echo -e "\n${BOLD}[2/5] Creating Postgres database...${RESET}"
if flyctl postgres list | grep -q "$DB_NAME"; then
  echo -e "${DIM}Database '$DB_NAME' already exists, skipping.${RESET}"
else
  flyctl postgres create \
    --name "$DB_NAME" \
    --region "$REGION" \
    --initial-cluster-size 1 \
    --vm-size shared-cpu-1x \
    --volume-size 10
  echo -e "${GREEN}✓ Postgres created${RESET}"
fi

# --- Step 3: Attach database to app ---
echo -e "\n${BOLD}[3/5] Attaching database to app...${RESET}"
flyctl postgres attach "$DB_NAME" --app "$APP_NAME" 2>/dev/null || \
  echo -e "${DIM}Database already attached, skipping.${RESET}"
echo -e "${GREEN}✓ Database attached${RESET}"

# --- Step 4: Enable pgvector extension ---
echo -e "\n${BOLD}[4/5] Enabling pgvector extension...${RESET}"
flyctl postgres connect --app "$DB_NAME" --command "CREATE EXTENSION IF NOT EXISTS vector;" 2>/dev/null || \
  echo -e "${DIM}Note: You may need to enable pgvector manually after deploy.${RESET}"

# --- Step 5: Set secrets ---
echo -e "\n${BOLD}[5/5] Setting secrets...${RESET}"

if [ -z "${OPENAI_API_KEY:-}" ]; then
  echo -e "${CYAN}Enter your OpenAI API key:${RESET}"
  read -s OPENAI_API_KEY
fi

flyctl secrets set \
  OPENAI_API_KEY="$OPENAI_API_KEY" \
  --app "$APP_NAME"

echo -e "${GREEN}✓ Secrets configured${RESET}"

# --- Summary ---
echo ""
echo -e "${BOLD}${GREEN}Infrastructure ready!${RESET}"
echo ""
echo -e "${DIM}Next steps:${RESET}"
echo -e "  1. Run database migration:"
echo -e "     ${CYAN}flyctl postgres connect --app $DB_NAME < packages/api/src/db/schema.sql${RESET}"
echo -e "  2. Deploy the API:"
echo -e "     ${CYAN}flyctl deploy${RESET}"
echo -e "  3. Verify:"
echo -e "     ${CYAN}curl https://$APP_NAME.fly.dev/health${RESET}"
echo ""
