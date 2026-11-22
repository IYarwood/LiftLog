#!/bin/bash
# Cache-bust the frontend's JS/CSS without a build step.
#
# The committed files reference assets as  foo.js?v=dev . This rewrites every
# "?v=<anything>" in the files below to "?v=<git short SHA>", so each deploy
# gives browsers (notably iOS Safari) new URLs for api.js / auth.js / auth.css.
#
#   ./stamp-assets.sh          stamp with the current commit
#   ./stamp-assets.sh --reset  put the committed text back (git checkout), so
#                              `git pull` never trips over the stamped files.
#                              Refuses (exit 1, nothing changed) if a file has
#                              any local edit other than ?v= values.
#
# Tradeoff: after stamping, `git status` in the deploy checkout shows these
# files as modified. That is expected; deploy.sh resets them before pulling.
# Adding a new <script>/<link>/import: give it "?v=dev" and list its file here.
set -e
cd "$(dirname "$0")"
FILES="frontend/index.html frontend/login.html frontend/js/auth.js"

# Same file with every ?v=<value> blanked out, for comparing ignoring stamps.
normalize() { sed -E 's/\?v=[A-Za-z0-9._-]+/?v=/g'; }

if [ "$1" = "--reset" ]; then
  # Only ever undo our own stamping. If a file differs from git in anything
  # other than ?v= values, someone edited it on the server: refuse rather than
  # silently throwing that edit away.
  BAD=""
  for f in $FILES; do
    if ! diff -q <(git show ":$f" | normalize) <(normalize < "$f") >/dev/null; then
      BAD="$BAD $f"
    fi
  done
  if [ -n "$BAD" ]; then
    echo "✗ stamp-assets.sh --reset: refusing to reset — these files have local" >&2
    echo "  changes besides the ?v= stamp:$BAD" >&2
    echo "  Inspect with: git diff --$BAD" >&2
    echo "  Commit or discard those edits yourself, then re-run." >&2
    exit 1
  fi
  git checkout -- $FILES
  exit 0
fi

VER="$(git rev-parse --short HEAD)"
sed -i -E "s/\?v=[A-Za-z0-9._-]+/?v=${VER}/g" $FILES
echo "→ Stamped asset version ${VER} into: ${FILES}"
