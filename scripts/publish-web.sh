#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
dotnet publish src/EmlToPst.Web --configuration Release \
  -p:RestoreLockedMode=true -p:NuGetLockFilePath=packages.browser.lock.json \
  --output artifacts/web --disable-build-servers -m:1
touch artifacts/web/wwwroot/.nojekyll
cp artifacts/web/wwwroot/index.html artifacts/web/wwwroot/404.html
python3 scripts/package-web-release.py
