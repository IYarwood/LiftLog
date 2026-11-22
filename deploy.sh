#!/bin/bash
# Run this on the VPS to deploy the latest main.
# Usage: ./deploy.sh
#
# Everything runs from main(), which bash parses completely before running, so
# a `git pull` that rewrites this file mid-run can't make bash execute half of
# the old script and half of the new one.

set -e

main() {
  cd /var/work/LiftLog

  echo "→ Un-stamping frontend asset versions (so git pull is clean)..."
  ./stamp-assets.sh --reset

  echo "→ Pulling latest changes..."
  git pull

  echo "→ Cache-busting frontend JS/CSS..."
  ./stamp-assets.sh

  echo "→ Installing dependencies..."
  cd /var/work/LiftLog/backend && npm install --omit=dev

  echo "→ Restarting app..."
  pm2 restart liftlog

  echo "✓ Done. Check status with: pm2 status"
}

main "$@"
exit
