#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

export HOME="$tmp/home"
export XDG_CONFIG_HOME="$tmp/config"
mkdir -p "$HOME"

# shellcheck disable=SC1090
source "$ROOT/scripts/phases/s6_wire_local.sh"

envfile=$(_write_agent_env_file "https://im.example.com" "agent-token" "access-token" "!agent:im.example.com")

grep -q 'DIREXIO_DOMAIN=https://im.example.com' "$envfile"
grep -q 'DIREXIO_AGENT_TOKEN=agent-token' "$envfile"
grep -q 'DIREXIO_AGENT_ROOM_ID=\\!agent:im.example.com' "$envfile"
! grep -q '^export P2P_' "$envfile"
! grep -q 'P2P_ADMIN_ACCESS_TOKEN' "$envfile"
! grep -q 'P2P_MATRIX_ACCESS_TOKEN' "$envfile"

# shellcheck disable=SC1090
source "$envfile"
[ "$DIREXIO_AGENT_ROOM_ID" = "!agent:im.example.com" ]

if grep -R 'P2P_MATRIX_AS_URL\|P2P_MATRIX_AGENT_TOKEN\|P2P_AGENT_RUNTIME\|p2p-agent-skill\|p2p-matrix-agent' "$ROOT/scripts" "$ROOT/SKILL.md" "$ROOT/references/runtime-wiring.md"; then
  echo "deprecated Matrix-AS env names or old agent skill wiring must not be used by deployer wiring" >&2
  exit 1
fi

[ "$(DIREXIO_AGENT_PLATFORM=hermes _detect_agent_runtime)" = "hermes" ]
[ "$(DIREXIO_AGENT_PLATFORM=openclaw _detect_agent_runtime)" = "openclaw" ]
[ "$(DIREXIO_AGENT_INSTALL=skip _agent_install_policy)" = "skip" ]
[ "$(DIREXIO_AGENT_INSTALL=recommend _agent_install_policy)" = "recommend" ]
[ "$(DIREXIO_AGENT_INSTALL=auto _agent_install_policy)" = "auto" ]
[ "$(_agent_install_mode hermes)" = "native" ]
[ "$(_agent_install_mode openclaw)" = "native" ]
[ "$(_agent_install_mode codex)" = "gateway" ]
[ "$(_agent_install_mode cursor)" = "mcp" ]
[ "$(DIREXIO_AGENT_INSTALL_MODE=gateway _agent_install_mode hermes)" = "gateway" ]

[ "$(_agent_skill_install_path codex)" = "PROJECT_ROOT/.codex/skills/direxio-deployer" ]
[ "$(_agent_skill_install_path claude-code)" = "PROJECT_ROOT/.claude/skills/direxio-deployer" ]
[ "$(_agent_skill_install_path gemini)" = "PROJECT_ROOT/.gemini/skills/direxio-deployer" ]
[ "$(_agent_skill_install_path cursor)" = "PROJECT_ROOT/.cursor/skills/direxio-deployer" ]
[ "$(_agent_skill_install_path copilot)" = "PROJECT_ROOT/.github/copilot/skills/direxio-deployer" ]
[ "$(_agent_skill_install_path openclaw)" = "PROJECT_ROOT/.openclaw/skills/direxio-deployer" ]
[ "$(_agent_skill_install_path hermes)" = "PROJECT_ROOT/.hermes/skills/direxio-deployer" ]
[ "$(_agent_skill_install_path unknown)" = "PROJECT_ROOT/.agent/skills/direxio-deployer" ]

[ "$(_agent_global_skill_install_path codex)" = '${CODEX_HOME:-$HOME/.codex}/skills/direxio-deployer' ]
[ "$(_agent_global_skill_install_path claude-code)" = '${CLAUDE_HOME:-$HOME/.claude}/skills/direxio-deployer' ]
[ "$(_agent_global_skill_install_path generic)" = '$HOME/.agent/skills/direxio-deployer' ]

[ "$(CODEX_HOME= _agent_mcp_config_path codex)" = "$HOME/.codex/direxio-agent/.mcp.json" ]
[ "$(CODEX_HOME=/mnt/c/Users/84960/.codex _agent_mcp_config_path codex)" = "/mnt/c/Users/84960/.codex/direxio-agent/.mcp.json" ]
[ "$(_agent_mcp_config_path claude-code)" = "$HOME/.claude/direxio-agent/.mcp.json" ]
[ "$(_agent_mcp_config_path openclaw)" = "$HOME/.openclaw/direxio/mcp.json" ]
[ "$(_agent_mcp_config_path hermes)" = "$HOME/.hermes/direxio.mcp.json" ]
[ "$(_agent_mcp_config_path cursor)" = "$XDG_CONFIG_HOME/direxio-agent/cursor.mcp.json" ]
[ "$(_agent_mcp_config_path copilot)" = "$XDG_CONFIG_HOME/direxio-agent/copilot.mcp.json" ]
[ "$(_agent_mcp_config_path gemini)" = "$HOME/.gemini/direxio.settings.json" ]
[ "$(_agent_mcp_config_path unknown)" = "$XDG_CONFIG_HOME/direxio-agent/mcp.json" ]

[ "$(_agent_project_mcp_target cursor)" = "PROJECT_ROOT/.cursor/mcp.json" ]
[ "$(_agent_project_mcp_target copilot)" = "PROJECT_ROOT/.github/copilot/mcp.json" ]
[ -z "$(_agent_project_mcp_target codex)" ]

cursor_summary=$(_agent_install_target_summary cursor "$(_agent_mcp_config_path cursor)")
[[ "$cursor_summary" == *"PROJECT_ROOT/.cursor/mcp.json"* ]]
[[ "$cursor_summary" == *"PROJECT_ROOT/.cursor/skills/direxio-deployer"* ]]

copilot_summary=$(_agent_install_target_summary copilot "$(_agent_mcp_config_path copilot)")
[[ "$copilot_summary" == *"read-only"* ]]
[[ "$copilot_summary" == *"PROJECT_ROOT/.github/copilot/mcp.json"* ]]
[[ "$copilot_summary" == *"PROJECT_ROOT/.github/copilot/skills/direxio-deployer"* ]]

install_command=$(_agent_install_command hermes native "$HOME/.p2p-matrix/credentials.json")
case "$install_command" in
  *"direxio-agent-install"*"--platform hermes"*"--mode native"*"--credentials-file"*"--write"*) ;;
  *)
    echo "install command did not include expected platform/mode/credentials/write flags: $install_command" >&2
    exit 1
    ;;
esac

echo "s6 wire local ok"
