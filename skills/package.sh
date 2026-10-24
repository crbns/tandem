#!/bin/sh
# Builds dist/tandem-skill.zip (repo root) from skills/tandem, with the tandem/
# folder at the top level of the archive. Ships only SKILL.md and README.md:
# COMPATIBILITY.md and eval/ hold the test prompts and results, not skill content.
set -eu

cd "$(dirname "$0")"
out="../dist/tandem-skill.zip"
mkdir -p ../dist
rm -f "$out"
zip -q "$out" tandem/SKILL.md tandem/README.md
echo "Built dist/tandem-skill.zip:"
unzip -l "$out"
