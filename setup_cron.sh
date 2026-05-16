#!/bin/bash
# PGCB Scraper — Cron Setup Helper
# Run this script to add an hourly cron job for the scraper.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_PATH="$(which node)"

echo "╔══════════════════════════════════════════════════╗"
echo "║   PGCB Scraper — Cron Setup                     ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""
echo "Script dir: $SCRIPT_DIR"
echo "Node path:  $NODE_PATH"
echo ""

CRON_CMD="0 * * * * cd \"$SCRIPT_DIR\" && $NODE_PATH scrape_pgcb.js >> scrape.log 2>&1"

echo "This will add the following cron job (runs every hour):"
echo "  $CRON_CMD"
echo ""
read -p "Add this cron job? (y/n): " confirm

if [ "$confirm" = "y" ] || [ "$confirm" = "Y" ]; then
  (crontab -l 2>/dev/null | grep -v "scrape_pgcb.js"; echo "$CRON_CMD") | crontab -
  echo "✅ Cron job added!"
  echo ""
  echo "Current crontab:"
  crontab -l
else
  echo "Cancelled."
fi

echo ""
echo "Manual commands:"
echo "  Full backfill:  cd \"$SCRIPT_DIR\" && node scrape_pgcb.js --all"
echo "  Latest only:    cd \"$SCRIPT_DIR\" && node scrape_pgcb.js"
echo "  Remove cron:    crontab -e  (delete the scrape_pgcb line)"
