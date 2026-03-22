#!/bin/bash
set -euo pipefail

# Central Intelligence — Database Setup
# For local development or manual Fly.io provisioning

BOLD='\033[1m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
DIM='\033[2m'
RESET='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCHEMA_FILE="$SCRIPT_DIR/../packages/api/src/db/schema.sql"

MODE="${1:-local}"

echo -e "${BOLD}"
echo "  Central Intelligence — Database Setup"
echo -e "${RESET}"

if [ "$MODE" = "local" ]; then
  DB_NAME="${CI_DB_NAME:-central_intelligence}"
  DB_URL="${DATABASE_URL:-postgres://localhost:5432/$DB_NAME}"

  echo -e "${CYAN}Mode:${RESET}     Local development"
  echo -e "${CYAN}Database:${RESET} $DB_NAME"
  echo ""

  # Create database if it doesn't exist
  if psql -lqt | cut -d \| -f 1 | grep -qw "$DB_NAME"; then
    echo -e "${DIM}Database '$DB_NAME' already exists.${RESET}"
  else
    echo "Creating database '$DB_NAME'..."
    createdb "$DB_NAME"
    echo -e "${GREEN}✓ Database created${RESET}"
  fi

  # Enable pgvector
  echo "Enabling pgvector extension..."
  psql -d "$DB_NAME" -c "CREATE EXTENSION IF NOT EXISTS vector;" 2>/dev/null || {
    echo ""
    echo -e "${CYAN}pgvector not installed. Install it:${RESET}"
    echo "  macOS:  brew install pgvector"
    echo "  Ubuntu: sudo apt install postgresql-16-pgvector"
    echo "  Docker: Use ankane/pgvector image"
    echo ""
    echo "Then re-run this script."
    exit 1
  }
  echo -e "${GREEN}✓ pgvector enabled${RESET}"

  # Run schema
  echo "Applying schema..."
  psql -d "$DB_NAME" -f "$SCHEMA_FILE"
  echo -e "${GREEN}✓ Schema applied${RESET}"

  echo ""
  echo -e "${GREEN}${BOLD}Local database ready!${RESET}"
  echo ""
  echo -e "${DIM}Connection string:${RESET}"
  echo -e "  ${CYAN}export DATABASE_URL=\"$DB_URL\"${RESET}"

elif [ "$MODE" = "fly" ]; then
  FLY_DB="${CI_FLY_DB:-ci-db}"

  echo -e "${CYAN}Mode:${RESET}     Fly.io"
  echo -e "${CYAN}App:${RESET}      $FLY_DB"
  echo ""

  echo "Applying schema to Fly.io Postgres..."
  flyctl postgres connect --app "$FLY_DB" < "$SCHEMA_FILE"
  echo -e "${GREEN}✓ Schema applied to Fly.io${RESET}"

else
  echo "Usage: $0 [local|fly]"
  echo ""
  echo "  local  — Set up local PostgreSQL (default)"
  echo "  fly    — Apply schema to Fly.io Postgres"
  exit 1
fi
