#!/usr/bin/env bash
# Fetch a freely-licensed font into public/fonts/. Falls back to copying a
# macOS system font (gitignored — not redistributable) when offline.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p public/fonts

ok() { # verify the file starts with a real sfnt/otf magic, not an HTML error page
  head -c 4 "$1" | od -An -tx1 | tr -d ' \n' | grep -qE '^(00010000|4f54544f)'
}

try_url() {
  local url="$1" out="$2"
  if curl -fsSL --max-time 30 "$url" -o "$out" && ok "$out"; then
    echo "fetched $out"
    return 0
  fi
  rm -f "$out"
  return 1
}

try_url "https://raw.githubusercontent.com/rsms/inter/master/docs/font-files/Inter-Regular.otf" \
  public/fonts/Inter-Regular.otf && exit 0

try_url "https://raw.githubusercontent.com/JetBrains/JetBrainsMono/master/fonts/ttf/JetBrainsMono-Regular.ttf" \
  public/fonts/JetBrainsMono-Regular.ttf && exit 0

for f in "/System/Library/Fonts/Supplemental/Arial.ttf" \
         "/System/Library/Fonts/Supplemental/Georgia.ttf" \
         "/System/Library/Fonts/Supplemental/Verdana.ttf"; do
  if [ -f "$f" ]; then
    cp "$f" public/fonts/local-fallback.ttf
    echo "copied system font: $f (gitignored)"
    exit 0
  fi
done

echo "could not obtain a font" >&2
exit 1
