#!/bin/sh
# Package the extension for the Chrome Web Store: dist/asc-fill-<version>.zip
set -e
cd "$(dirname "$0")"
version=$(sed -n 's/.*"version": "\(.*\)".*/\1/p' manifest.json)
mkdir -p dist
rm -f "dist/asc-fill-$version.zip"
zip -qr "dist/asc-fill-$version.zip" manifest.json src popup icons -x '*.DS_Store'
echo "dist/asc-fill-$version.zip"
