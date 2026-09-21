#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
TOOLS_DIR="$CODEX_HOME/tools/devo"
SKILL_DIR="$CODEX_HOME/skills/devo"
CONFIG_DIR="$HOME/.devo"
BIN_DIR="${DEVO_BIN_DIR:-$HOME/.local/bin}"
HOOK_DIR="${DEVO_HOOK_DIR:-$HOME/.claude/hooks}"
SETTINGS="$HOME/.claude/settings.json"

echo "Installing Devo into $CODEX_HOME"

mkdir -p "$TOOLS_DIR"
mkdir -p "$SKILL_DIR"
mkdir -p "$CONFIG_DIR"
mkdir -p "$BIN_DIR"

cp "$SCRIPT_DIR/index.js" "$TOOLS_DIR/index.js"
cp "$SCRIPT_DIR/package.json" "$TOOLS_DIR/package.json"
rm -rf "$TOOLS_DIR/scripts"
cp -R "$SCRIPT_DIR/scripts" "$TOOLS_DIR/scripts"
chmod +x "$TOOLS_DIR/index.js"

cat > "$BIN_DIR/devo" << EOF
#!/bin/sh
exec node "$TOOLS_DIR/index.js" "\$@"
EOF
chmod +x "$BIN_DIR/devo"

cp "$SCRIPT_DIR/SKILL.md" "$SKILL_DIR/SKILL.md"
rm -rf "$SKILL_DIR/agents" "$SKILL_DIR/references"
cp -R "$SCRIPT_DIR/agents" "$SKILL_DIR/agents"
cp -R "$SCRIPT_DIR/references" "$SKILL_DIR/references"

mkdir -p "$HOOK_DIR"
cp "$SCRIPT_DIR/hooks/gcloud-guard.sh" "$HOOK_DIR/gcloud-guard.sh"
chmod +x "$HOOK_DIR/gcloud-guard.sh"

if [ -f "$SCRIPT_DIR/../devo.config.example.json" ]; then
  cp "$SCRIPT_DIR/../devo.config.example.json" "$CONFIG_DIR/config.example.json"
fi

if [ -f "$SCRIPT_DIR/../devo.config.json" ] && [ ! -f "$CONFIG_DIR/config.json" ]; then
  cp "$SCRIPT_DIR/../devo.config.json" "$CONFIG_DIR/config.json"
  chmod 600 "$CONFIG_DIR/config.json"
fi

# Every copy this script writes is recorded with its digest, so a copy edited in
# place can be named later instead of being found by accident. An installed edit
# works immediately and the divergence surfaces much later, when it is no longer
# clear which copy is the truth -- that is what `devo doctor` now reports, and it
# needs this file to have something to compare against.
MANIFEST="$TOOLS_DIR/INSTALLED.json"
if ! command -v shasum >/dev/null 2>&1; then
  echo "  note: shasum not found; the install manifest was not written, so drift cannot be reported"
else
  REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
  REPO_COMMIT=""
  if command -v git >/dev/null 2>&1 && git -C "$REPO_DIR" rev-parse --short HEAD >/dev/null 2>&1; then
    REPO_COMMIT="$(git -C "$REPO_DIR" rev-parse --short HEAD)"
  fi

  first_entry=1
  # target: which part of the installation this copy belongs to
  record() {
    target=$1
    source_rel=$2
    installed=$3
    [ -f "$installed" ] || return 0
    [ "$first_entry" = 1 ] || printf ',\n'
    first_entry=0
    printf '    { "target": "%s", "source": "%s", "installed": "%s", "sha256": "%s" }' \
      "$target" "$source_rel" "$installed" "$(shasum -a 256 "$installed" | awk '{print $1}')"
  }

  {
    printf '{\n'
    printf '  "installedAt": "%s",\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    printf '  "repo": "%s",\n' "$REPO_DIR"
    printf '  "repoCommit": "%s",\n' "$REPO_COMMIT"
    printf '  "artifacts": [\n'
    record runtime "skill/index.js" "$TOOLS_DIR/index.js"
    record runtime "skill/package.json" "$TOOLS_DIR/package.json"
    for file in "$SCRIPT_DIR"/scripts/*.mjs; do
      name="$(basename "$file")"
      record runtime "skill/scripts/$name" "$TOOLS_DIR/scripts/$name"
    done
    record skill "skill/SKILL.md" "$SKILL_DIR/SKILL.md"
    for file in "$SCRIPT_DIR"/agents/* "$SCRIPT_DIR"/references/*; do
      name="$(basename "$file")"
      case "$file" in
        */agents/*) record skill "skill/agents/$name" "$SKILL_DIR/agents/$name" ;;
        */references/*) record skill "skill/references/$name" "$SKILL_DIR/references/$name" ;;
      esac
    done
    record hook "skill/hooks/gcloud-guard.sh" "$HOOK_DIR/gcloud-guard.sh"
    printf '\n  ]\n}\n'
  } > "$MANIFEST.tmp"
  mv "$MANIFEST.tmp" "$MANIFEST"
fi

echo "Installed Devo skill:"
echo "  tool:  $TOOLS_DIR/index.js"
echo "  cli:   $BIN_DIR/devo"
echo "  skill: $SKILL_DIR/SKILL.md"
echo "  hook:  $HOOK_DIR/gcloud-guard.sh"
if [ -f "$SETTINGS" ] && ! grep -q "gcloud-guard.sh" "$SETTINGS"; then
  echo "  note: the guard is not registered in $SETTINGS; add it under"
  echo "        hooks.PreToolUse with \"matcher\": \"Bash\"."
fi
echo "  config example: $CONFIG_DIR/config.example.json"
if [ -f "$CONFIG_DIR/config.json" ]; then
  echo "  config: $CONFIG_DIR/config.json"
fi

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "  note: $BIN_DIR is not in PATH; add it to use 'devo' from any directory." ;;
esac
