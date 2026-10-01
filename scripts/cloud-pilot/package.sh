#!/usr/bin/env bash
set -euo pipefail
# Runs only in GitHub CI. No install/build on the user's Mac or Box.
cp -R apps/web/dist apps/server/dist/client
pnpm --filter t3 deploy --prod --legacy /tmp/t3-pilot-runtime
node /tmp/t3-pilot-runtime/dist/bin.mjs --help >/dev/null
python3 scripts/cloud-pilot/smoke_runtime.py
tar -czf pilot-runtime.tgz -C /tmp/t3-pilot-runtime .
digest=$(sha256sum pilot-runtime.tgz | cut -d' ' -f1)
if test -n "${GITHUB_OUTPUT:-}"; then echo "digest=$digest" >> "$GITHUB_OUTPUT"; fi
