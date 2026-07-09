#!/usr/bin/env bash
set -euo pipefail

# Run this on a deployed Direxio host from the docker-compose directory.
# It verifies the product-agent data plane without printing secrets:
# memory write/read, prompt skill sync/read, optional product-agent restart,
# and one real message-server event handled through the configured AI gateway.

COMPOSE_ENV_FILE="${DIREXIO_REMOTE_ENV_FILE:-.env}"
SMOKE_ID="${DIREXIO_PRODUCT_AGENT_SMOKE_ID:-remote-smoke-$(date +%s)}"
SMOKE_RESTART="${DIREXIO_PRODUCT_AGENT_SMOKE_RESTART:-1}"
SMOKE_URL="${DIREXIO_PRODUCT_AGENT_SMOKE_URL:-http://127.0.0.1:8797}"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is not installed or not in PATH" >&2
  exit 1
fi

if docker ps >/dev/null 2>&1; then
  docker_cmd=(docker)
elif command -v sudo >/dev/null 2>&1 && sudo docker ps >/dev/null 2>&1; then
  docker_cmd=(sudo docker)
else
  echo "docker is installed but this user cannot access it" >&2
  exit 1
fi

compose=("${docker_cmd[@]}" compose)
if [ -n "${COMPOSE_ENV_FILE}" ]; then
  if [ -f "${COMPOSE_ENV_FILE}" ]; then
    compose+=(--env-file "${COMPOSE_ENV_FILE}")
  elif [ -n "${DIREXIO_REMOTE_ENV_FILE:-}" ]; then
    echo "DIREXIO_REMOTE_ENV_FILE points to a missing file: ${COMPOSE_ENV_FILE}" >&2
    exit 1
  fi
fi

if ! "${compose[@]}" ps product-agent >/dev/null 2>&1; then
  echo "product-agent is not available in this compose project" >&2
  exit 1
fi

run_inside_product_agent() {
  local phase="$1"
  "${compose[@]}" exec -T \
    -e PRODUCT_AGENT_SMOKE_ID="${SMOKE_ID}" \
    -e PRODUCT_AGENT_SMOKE_PHASE="${phase}" \
    -e PRODUCT_AGENT_SMOKE_URL="${SMOKE_URL}" \
    product-agent node dist/bin/remote-smoke-runner.js
}

echo "Running product-agent remote smoke: ${SMOKE_ID}"
run_inside_product_agent write

if [ "${SMOKE_RESTART}" = "1" ]; then
  echo "Restarting product-agent to verify persisted memory and skills..."
  "${compose[@]}" restart product-agent >/dev/null
else
  echo "Skipping restart because DIREXIO_PRODUCT_AGENT_SMOKE_RESTART=${SMOKE_RESTART}"
fi

run_inside_product_agent verify
echo "product-agent remote smoke passed"
