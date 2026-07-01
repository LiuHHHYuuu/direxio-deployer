#!/usr/bin/env bash
# S1 PREFLIGHT - default VPC, EC2 vCPU quota, and AMI checks.
#
# New AWS accounts often start with low or zero EC2 quota. Report the blocker
# and keep polling instead of losing deployment state.

run_phase() {
  aws_env_prep
  phase_set S1_PREFLIGHT in_progress "running preflight checks"

  # 1) Default VPC.
  local vpc
  vpc=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true \
        --query 'Vpcs[0].VpcId' --output text 2>/dev/null || echo "None")
  if [ "$vpc" = "None" ] || [ -z "$vpc" ]; then
    phase_set S1_PREFLIGHT failed "no default VPC in this region"
    fail "This region has no default VPC. In the AWS console, go to VPC -> Create default VPC, or choose another region."
  fi
  res_set vpc_id "$vpc"
  log "Default VPC = $vpc"

  # 2) vCPU quota. t3.small requires 2 vCPU. Unknown quota is warned but not blocked.
  local quota
  quota=$(aws service-quotas get-service-quota --service-code ec2 --quota-code "$EC2_STD_QUOTA_CODE" \
          --query 'Quota.Value' --output text 2>/dev/null || echo "unknown")
  quota=${quota:-unknown}
  log "On-Demand Standard instance vCPU quota = $quota (need 2)"
  if _is_unknown_quota "$quota"; then
    warn "Could not read quota; continuing. If run-instances returns VcpuLimitExceeded, quota is insufficient."
  elif ! _num_ge "$quota" 2; then
    phase_set S1_PREFLIGHT waiting_user "vCPU quota=$quota (<2), waiting for quota increase"
    warn "EC2 vCPU quota is $quota (<2), which is common on new AWS accounts."
    warn "Open Service Quotas -> Amazon EC2 ->"
    warn "  'Running On-Demand Standard (A,C,D,H,I,M,R,T,Z) instances' and request quota >= 2."
    warn "After submitting the request, you can leave this running; it checks every ${QUOTA_POLL_INTERVAL:-300}s."
    poll_until "vCPU quota >= 2" "${QUOTA_POLL_INTERVAL:-300}" 0 _quota_ge_2 \
      || { phase_set S1_PREFLIGHT failed "quota polling interrupted"; return 1; }
  fi

  # 3) Elastic IP quota. Production domains need one free EIP before S3 creates resources.
  local eip_quota eip_used
  eip_quota=$(aws service-quotas get-service-quota --service-code ec2 --quota-code "$EC2_EIP_QUOTA_CODE" \
          --query 'Quota.Value' --output text 2>/dev/null || echo "unknown")
  eip_quota=${eip_quota:-unknown}
  eip_used=$(aws ec2 describe-addresses --query 'length(Addresses)' --output text 2>/dev/null || echo "unknown")
  eip_used=${eip_used:-unknown}
  res_set eip_quota "$eip_quota"
  res_set eip_allocated_count "$eip_used"
  log "Elastic IP quota = $eip_quota, allocated = $eip_used (need 1 free)"
  if _is_unknown_quota "$eip_quota" || _is_unknown_quota "$eip_used"; then
    warn "Could not read Elastic IP quota/usage; continuing. If AllocateAddress returns AddressLimitExceeded, choose another region, release unused EIPs, or request a quota increase."
  elif _num_ge "$eip_used" "$eip_quota"; then
    phase_set S1_PREFLIGHT waiting_user "Elastic IP quota exhausted: allocated=$eip_used quota=$eip_quota"
    warn "Elastic IP quota is exhausted in this region: allocated=$eip_used quota=$eip_quota."
    warn "Choose another AWS region, destroy an old Direxio node, release an unused EIP, or request an Elastic IP quota increase before provisioning."
    return 2
  fi

  # 4) AMI (amd64/x86).
  local ami
  ami=$(aws_lookup_ubuntu_ami)
  if [ "$ami" = "None" ] || [ -z "$ami" ]; then
    phase_set S1_PREFLIGHT failed "failed to resolve Ubuntu AMI"
    fail "Could not resolve Ubuntu 22.04 amd64 AMI (SSM parameter unavailable)."
  fi
  res_set ami_id "$ami"
  log "AMI = $ami (Ubuntu 22.04 amd64/x86, user=ubuntu)"

  phase_set S1_PREFLIGHT done "vpc=$vpc quota=$quota eip=$eip_used/$eip_quota ami=$ami"
  return 0
}

# Values used when quota cannot be read. These warn but do not block.
_is_unknown_quota() {
  case "$1" in ""|unknown|None|null) return 0;; *) return 1;; esac
}

# Numeric comparison $1 >= $2. Use -v to avoid awk syntax errors on empty/non-numeric input.
_num_ge() {
  awk -v a="$1" -v b="$2" 'BEGIN{ if (a+0 >= b+0) exit 0; else exit 1 }'
}

# Quota >= 2 check for poll_until. Empty/None counts as not ready.
_quota_ge_2() {
  local q
  q=$(aws service-quotas get-service-quota --service-code ec2 --quota-code "$EC2_STD_QUOTA_CODE" \
      --query 'Quota.Value' --output text 2>/dev/null || echo "0")
  q=${q:-0}
  _is_unknown_quota "$q" && return 1
  _num_ge "$q" 2
}
