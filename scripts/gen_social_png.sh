#!/usr/bin/env bash
# Rasterise the two SVG source images into the PNGs a social scraper and a
# submission gallery can actually read.
#
# Why this exists: no major platform (X, Slack, Discord, LinkedIn, Facebook)
# renders an SVG `og:image`, and Devpost's project-thumbnail uploader accepts
# png/jpg/gif only. The SVGs stay the source of truth — `test/docs.test.ts`
# checks their wording against renderRetraction() — and these are generated
# from them, committed, and gated on their pixel dimensions by web/web.test.ts.
#
# This is the ONE thing in this repo that needs a tool `npm install` does not
# bring: librsvg (`brew install librsvg`). It is deliberately not part of any
# command DEMO.md asks a judge to run, and the outputs are committed so nobody
# has to install it to see the card.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

command -v rsvg-convert >/dev/null || { echo "need rsvg-convert (brew install librsvg)"; exit 1; }

# 1200x630 is the Open Graph card size every scraper crops to. The background is
# painted in because a transparent PNG renders black-on-black in some clients.
rsvg-convert -w 1200 -h 630 -b '#0B0D0E' docs/og.svg   -o docs/og.png
rsvg-convert -w 512  -h 512               docs/icon.svg -o docs/icon.png

ls -l docs/og.png docs/icon.png
