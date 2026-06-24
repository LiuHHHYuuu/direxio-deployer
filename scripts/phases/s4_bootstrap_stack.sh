#!/usr/bin/env bash
# S4 BOOTSTRAP_STACK - cloud-init installs Docker, starts the stack, and gets TLS.
# The local agent polls https://<domain>/healthz until it returns 200.

run_phase() {
  phase_set S4_BOOTSTRAP_STACK polling "waiting for instance bootstrap and services"
  local domain pubip keyfile
  domain=$(state_get domain)
  pubip=$(res_get public_ip)
  keyfile=$(res_get key_file)

  log "Waiting for bootstrap (install Docker -> start postgres/message-server/caddy/coturn -> issue Let's Encrypt certificate)..."
  log "First image pull and certificate issuance usually take 5-10 minutes. Checking https://$domain/healthz every ${HEALTH_POLL_INTERVAL:-10}s ..."

  if poll_until "health check https://$domain/healthz == 200" \
       "${HEALTH_POLL_INTERVAL:-10}" "${HEALTH_POLL_MAX:-90}" _healthz_ok "$domain"; then
    phase_set S4_BOOTSTRAP_STACK done "healthz 200 @ https://$domain"
    return 0
  fi

  phase_set S4_BOOTSTRAP_STACK failed "healthz did not return 200 before timeout"
  warn "Health check timed out. Inspect cloud-init logs over SSH:"
  warn "  ssh -i $keyfile ubuntu@$pubip 'sudo tail -n 80 /var/log/cloud-init-output.log; cd /opt/p2p && sudo docker compose ps && sudo docker compose logs message-server --tail=80'"
  warn "See references/troubleshooting.md for targeted troubleshooting."
  return 1
}

_healthz_ok() {
  local domain=$1 pubip
  pubip=$(res_get public_ip)
  if [ -n "$pubip" ]; then
    curl -skf --resolve "$domain:443:$pubip" "https://$domain/healthz" >/dev/null 2>&1 && return 0
  fi
  curl -skf "https://$domain/healthz" >/dev/null 2>&1
}
