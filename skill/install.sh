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
