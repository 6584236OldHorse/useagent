#!/bin/sh
# Build the hosted runtime archive from a clean fork checkout:
# server + bundled web client, then the source marker and SHA256SUMS.
set -eu
REPO="$1"; OUT="$2"
cd "$REPO"
test -z "$(git status --porcelain)" || { echo "fork tree is dirty" >&2; exit 1; }
SHA="$(git rev-parse HEAD)"
rm -rf apps/server/dist apps/web/dist
pnpm exec vp run --filter t3 build >/dev/null
cd apps/server/dist
printf '%s\n' "$SHA" > T3_SOURCE_COMMIT
find . -type f ! -name SHA256SUMS | LC_ALL=C sort | xargs shasum -a 256 > SHA256SUMS
NAME="native-runtime-$(printf %.12s "$SHA").tar.gz"
COPYFILE_DISABLE=1 tar --no-xattrs --no-mac-metadata --no-acls --uid 0 --gid 0 --uname root --gname root -czf "$OUT/$NAME" .
echo "$OUT/$NAME"
