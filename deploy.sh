#!/bin/bash
# Run this on the VPS after every git pull
# Usage: ./deploy.sh

set -e

echo "→ Pulling latest changes..."
git pull

echo "→ Installing dependencies..."
cd /var/work/LiftLog/backend && npm install --omit=dev

echo "→ Restarting app..."
pm2 restart liftlog

echo "✓ Done. Check status with: pm2 status"
