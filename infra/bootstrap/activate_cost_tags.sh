#!/usr/bin/env bash
# Activate the cost-allocation tags the FinOps stack groups by (ADR-0014).
#
# WHY THIS IS A BOOTSTRAP STEP AND NOT TERRAFORM:
#
# Tag activation is NOT retroactive. Cost Explorer and the Cost and Usage
# Report only attribute spend to a tag key from the moment that key is
# activated onward — spend already incurred stays permanently unattributable,
# and no later action recovers it. So this has to run BEFORE the first dollar
# is spent, which means before Terraform runs at all.
#
# It also lives here because tag activation is an ACCOUNT-level, billing-scoped
# operation available only in us-east-1, and it has no CloudFormation or
# Terraform resource that manages it idempotently.
#
# Safe to re-run: activating an already-active key is a no-op.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./config.sh
source "${SCRIPT_DIR}/config.sh"
# shellcheck source=./_common.sh
source "${SCRIPT_DIR}/_common.sh"

# The billing endpoints are global but only answer in us-east-1.
BILLING_REGION="us-east-1"

# Every tag the platform attaches via provider default_tags. `Project` and
# `Environment` are the two the FinOps page groups by; `Stack` makes a cost
# spike attributable to the change that caused it.
TAG_KEYS=(Project Environment Stack ManagedBy)

log "Activating cost-allocation tags in account ${ACCOUNT_ID}"

# Probe FIRST, because the two failure modes need opposite advice and are
# otherwise indistinguishable in the output.
#
# In an AWS Organization, cost-allocation tags are owned by the PAYER account.
# A linked account gets `AccessDeniedException: Linked account doesn't have
# access to cost allocation tags` on every call — so the per-key loop below
# would print "not activatable yet, re-run after the first apply" four times,
# which is advice that can never succeed here. Saying which world we are in is
# the difference between a next step and a wild goose chase.
if ! probe="$(aws_ ce list-cost-allocation-tags --region "${BILLING_REGION}" \
      --max-results 1 --output text 2>&1)"; then
  if printf '%s' "${probe}" | grep -q "Linked account"; then
    cat <<EOF

==> This is a LINKED account; cost-allocation tags are the payer's to activate.

  Every resource already carries Project, Environment, Stack and ManagedBy via
  provider default_tags, so nothing is missing on this side. Until the PAYER
  account activates those keys, the Cost and Usage Report carries only the keys
  it has already activated, and the FinOps page groups by those alone.

  Activation is not retroactive (ADR-0014): spend incurred before the payer
  activates a key stays unattributable to it forever.

EOF
    exit 0
  fi
  die "cannot read cost-allocation tags: ${probe}"
fi

for key in "${TAG_KEYS[@]}"; do
  if [ -n "${DRYRUN}" ]; then
    sub "DRYRUN: would activate '${key}'"
    continue
  fi
  # The API takes the full desired set per call for a single key; looping keeps
  # the failure attributable to one key rather than to "the batch".
  if aws_ ce update-cost-allocation-tags-status --region "${BILLING_REGION}" \
      --cost-allocation-tags-status "TagKey=${key},Status=Active" \
      --output text >/dev/null 2>&1; then
    sub "activated '${key}'"
  else
    # A key AWS has never seen on a resource cannot be activated yet. That is
    # expected on a fresh account and is not a failure — re-run after the first
    # apply. Anything else is a real error and the status query below shows it.
    sub "'${key}' not activatable yet (AWS has not observed it on a resource)"
  fi
done

log "Current status"
aws_ ce list-cost-allocation-tags --region "${BILLING_REGION}" \
  --query 'CostAllocationTags[].{Tag:TagKey,Status:Status,Type:Type}' \
  --output table 2>/dev/null || sub "unable to list — check billing permissions"

cat <<EOF

==> Tag activation converged.

  Keys become activatable only after AWS has observed them on a real resource,
  so on a fresh account this is a two-pass operation: run it now, apply the
  first stack, then run it again. Spend before activation is unattributable
  forever, which is why it runs first regardless.

EOF
