#!/bin/bash
# Cache-bust the frontend's JS/CSS without a build step.
#
# The committed files reference assets as  foo.js?v=dev . This rewrites every
# "?v=<anything>" in the files below to "?v=<git short SHA>", so each deploy
# gives browsers (notably iOS Safari) new URLs for api.js / auth.js / auth.css.
#
#   ./stamp-assets.sh          stamp with the current commit
#   ./stamp-assets.sh --reset  put the committed text back (git checkout), so
#                              `git pull` never trips over the stamped files
#
# Tradeoff: after stamping, `git status` in the deploy checkout shows these
# files as modified. That is expected; deploy.sh resets them before pulling.
# Adding a new <script>/<link>/import: give it "?v=dev" and list its file here.
set -e
cd "$(dirname "$0")"
FILES="frontend/index.html frontend/login.html frontend/js/auth.js"

if [ "$1" = "--reset" ]; then
  git checkout -- $FILES
  exit 0
fi

VER="$(git rev-parse --short HEAD)"
sed -i -E "s/\?v=[A-Za-z0-9._-]+/?v=${VER}/g" $FILES
echo "→ Stamped asset version ${VER} into: ${FILES}"
