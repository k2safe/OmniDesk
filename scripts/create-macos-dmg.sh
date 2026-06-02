#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(node -p "require('${ROOT_DIR}/package.json').version")"
ARCH="$(uname -m)"

if [[ "${ARCH}" == "arm64" ]]; then
  PLATFORM_ID="macos-aarch64"
else
  PLATFORM_ID="macos-x86_64"
fi

APP_PATH="${ROOT_DIR}/src-tauri/target/release/bundle/macos/OmniDesk.app"
DIST_DIR="${ROOT_DIR}/dist-release"
DMG_PATH="${DIST_DIR}/OmniDesk-v${VERSION}-${PLATFORM_ID}.dmg"
STAGING_DIR="$(mktemp -d "/private/tmp/omnidesk-dmg.XXXXXX")"

cleanup() {
  rm -rf "${STAGING_DIR}"
}
trap cleanup EXIT

if [[ ! -d "${APP_PATH}" ]]; then
  echo "Missing macOS app bundle: ${APP_PATH}" >&2
  exit 1
fi

mkdir -p "${DIST_DIR}"
cp -R "${APP_PATH}" "${STAGING_DIR}/OmniDesk.app"
ln -s /Applications "${STAGING_DIR}/Applications"

osascript -e "do shell script \"hdiutil create -volname OmniDesk -srcfolder ${STAGING_DIR} -ov -format UDZO ${DMG_PATH}\"" < /dev/null
echo "Created ${DMG_PATH}"
