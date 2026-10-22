#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
dotnet publish src/EmlToPst.Web --configuration Release \
  -p:RestoreLockedMode=true -p:NuGetLockFilePath=packages.browser.lock.json \
  --output artifacts/web
touch artifacts/web/wwwroot/.nojekyll
cp artifacts/web/wwwroot/index.html artifacts/web/wwwroot/404.html
