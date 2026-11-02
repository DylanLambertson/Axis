#!/usr/bin/env bash
# Copyright (c) 2026 Dylan Lambertson. All rights reserved.
#
# Regenerates the Axis icon and image replacements in code-oss/replace/ from
# assets/brand/ (docs/design/axis-shell.md §2.6). The outputs are committed, so
# builds need no image toolchain; rerun this script after a brand change and
# review the diff.
#
# Rasters are drawn from the vector at their final size by headless Chrome
# (scripts/code-oss/icons/render.html), packed into ICO/XPM by
# scripts/code-oss/icons/pack.py (Python 3 standard library) and into ICNS by
# iconutil. macOS only: iconutil ships with macOS.
#
# Chrome is looked up at $AXIS_CHROME, then the default macOS install path.
# Chrome's rasteriser changes between versions, so outputs are reproducible by
# this script but not byte-identical across Chrome releases.
#
# Usage: scripts/code-oss/gen-icons.sh [--check]
#   --check  fails if the committed SVG replacements differ from the brand assets
#            (rasters are not compared, see above).
set -euo pipefail

# shellcheck source=scripts/code-oss/lib.sh
. "$(dirname "$0")/lib.sh"

check=0
for arg in "$@"; do
	case "$arg" in
	--check) check=1 ;;
	-h | --help)
		sed -n '2,20p' "$0"
		exit 0
		;;
	*) die "unknown argument: $arg" ;;
	esac
done

BRAND_DIR="$AXIS_ROOT/assets/brand"
ICONS_DIR="$AXIS_ROOT/scripts/code-oss/icons"
APP_ICON="$BRAND_DIR/axis-app-icon.svg"
MARK="$BRAND_DIR/axis-mark.svg"
[ -f "$APP_ICON" ] && [ -f "$MARK" ] || die "brand assets missing in $BRAND_DIR"

work="$(mktemp -d "${TMPDIR:-/tmp}/axis-gen-icons.XXXXXX")"
trap 'rm -rf "$work"' EXIT

# --- Vector replacements -------------------------------------------------------

# mark_paths: the <path> elements of the brand mark, with gradient fills.
mark_paths() {
	sed -n 's/.*<\/defs>\(.*\)<\/svg>.*/\1/p' "$MARK"
}
mark_defs() {
	sed -n 's/.*\(<defs>.*<\/defs>\).*/\1/p' "$MARK"
}
# Square viewBox centred on the mark (the mark's own viewBox is 554 x 406 at 320,163).
SQUARE_VIEWBOX='320 89 554 554'

# letterpress FILL OPACITY: monochrome mark, matching the upstream letterpress
# attributes (fill or opacity) for each theme kind.
letterpress() {
	local fill="$1" opacity="$2" paths
	paths="$(mark_paths | sed 's/ fill="url(#axis-mark-[a-z]*)"//g')"
	printf '<svg xmlns="http://www.w3.org/2000/svg" width="260" height="260" viewBox="%s"%s fill="%s">%s</svg>\n' \
		"$SQUARE_VIEWBOX" "${opacity:+ opacity=\"$opacity\"}" "$fill" "$paths"
}

svg_out="$work/svg"
mkdir -p "$svg_out/src/vs/workbench/browser/media" "$svg_out/src/vs/workbench/browser/parts/editor/media"
printf '<svg xmlns="http://www.w3.org/2000/svg" viewBox="%s">%s%s</svg>\n' "$SQUARE_VIEWBOX" "$(mark_defs)" "$(mark_paths)" \
	>"$svg_out/src/vs/workbench/browser/media/code-icon.svg"
# Upstream: dark and light use the default (black) fill at opacity 0.3 and 0.1;
# the high-contrast variants use an explicit grey and no opacity.
letterpress '#000000' 0.3 >"$svg_out/src/vs/workbench/browser/parts/editor/media/letterpress-dark.svg"
letterpress '#000000' 0.1 >"$svg_out/src/vs/workbench/browser/parts/editor/media/letterpress-light.svg"
letterpress '#3C3C3C' '' >"$svg_out/src/vs/workbench/browser/parts/editor/media/letterpress-hcDark.svg"
letterpress '#D9D9D9' '' >"$svg_out/src/vs/workbench/browser/parts/editor/media/letterpress-hcLight.svg"

if [ "$check" = 1 ]; then
	stale=0
	while IFS= read -r rel; do
		if ! cmp -s "$svg_out/$rel" "$REPLACE_DIR/$rel"; then
			printf 'stale: code-oss/replace/%s\n' "$rel" >&2
			stale=1
		fi
	done < <(cd "$svg_out" && find . -type f | sed 's|^\./||' | sort)
	[ "$stale" = 0 ] || die "SVG replacements differ from assets/brand; rerun scripts/code-oss/gen-icons.sh"
	log "SVG replacements match assets/brand"
	exit 0
fi

# --- Rasters -----------------------------------------------------------------

[ "$(uname -s)" = Darwin ] || die "raster generation needs macOS (iconutil)"
command -v iconutil >/dev/null || die "iconutil not found"
command -v python3 >/dev/null || die "python3 not found"
chrome="${AXIS_CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
[ -x "$chrome" ] || die "Chrome not found at '$chrome'; set AXIS_CHROME"

b64() { base64 <"$1" | tr -d '\n'; }
sources="{\"icon\":\"data:image/svg+xml;base64,$(b64 "$APP_ICON")\"}"
# The page has two placeholders; jobs.json is inlined as a JavaScript literal.
# Literal replacement (index/substr): sub() would expand "&" in the inlined text.
awk -v sources="$sources" -v jobsfile="$ICONS_DIR/jobs.json" '
	function put(s, marker, value,    i) {
		i = index(s, marker)
		return i ? substr(s, 1, i - 1) value substr(s, i + length(marker)) : s
	}
	index($0, "/*SOURCES*/{}") { $0 = put($0, "/*SOURCES*/{}", sources) }
	index($0, "/*JOBS*/[]") {
		jobs = ""
		while ((getline line < jobsfile) > 0) jobs = jobs line "\n"
		$0 = put($0, "/*JOBS*/[]", jobs)
	}
	{ print }
' "$ICONS_DIR/render.html" >"$work/render.html"

log "Rendering $(grep -c '"name"' "$ICONS_DIR/jobs.json") rasters with $("$chrome" --version)"
"$chrome" --headless=new --disable-gpu --no-first-run --no-default-browser-check \
	--user-data-dir="$work/chrome-profile" --virtual-time-budget=20000 \
	--dump-dom "file://$work/render.html" >"$work/dom.html" 2>"$work/chrome.log" ||
	{
		cat "$work/chrome.log" >&2
		die "headless Chrome failed"
	}

python3 -I "$ICONS_DIR/pack.py" "$ICONS_DIR/jobs.json" "$work/dom.html" "$work/raster"
mkdir -p "$work/raster/resources/darwin"
iconutil -c icns -o "$work/raster/resources/darwin/code.icns" "$work/raster/code.iconset" ||
	die "iconutil failed"
rm -rf "$work/raster/code.iconset"

# --- Install into code-oss/replace -------------------------------------------

for dir in "$svg_out" "$work/raster"; do
	(cd "$dir" && find . -type f) | sed 's|^\./||' | sort | while IFS= read -r rel; do
		mkdir -p "$(dirname "$REPLACE_DIR/$rel")"
		cp "$dir/$rel" "$REPLACE_DIR/$rel"
		printf '  %s\n' "code-oss/replace/$rel" >&2
	done
done
log "Icons written to code-oss/replace/; review with git diff --stat"
