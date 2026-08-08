#!/usr/bin/env bash
# CloudFormation bootstrap driver — the trust floor BELOW Terraform (ADR-0004).
#
# Nothing here names a specific account or region: platform identity comes from
# ./config.sh, and application identity is derived from the enclosing git repo.
#
# Two stacks, both idempotent (`aws cloudformation deploy` is create-or-update):
#
#   1. cfn/github-oidc.yaml       stack github-oidc-baseline, ONCE per ACCOUNT.
#        The GitHub OIDC provider — an account singleton, hence its own stack.
#   2. cfn/tfstate-bootstrap.yaml stack <app>-bootstrap, once per APP.
#        <app>-tfstate-<acct> state bucket + <app>-github-deployer role.
#
# Plus a read-only DNS check: the apex zone must already exist, because a zone
# created here would carry nameservers nobody has delegated to.
#
# Review before mutating:  DRYRUN=1 infra/bootstrap/bootstrap_cfn.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

[ -f "${SCRIPT_DIR}/config.sh" ] || {
  echo "ERROR: ${SCRIPT_DIR}/config.sh missing — it names the target platform" >&2
  exit 1
}
# shellcheck source=./config.sh
source "${SCRIPT_DIR}/config.sh"
# shellcheck source=./_common.sh
source "${SCRIPT_DIR}/_common.sh"

log "Bootstrapping '${APP_NAME}' (repo ${GITHUB_REPO}) into account ${ACCOUNT_ID} / ${REGION}"

# --- Step 1: the OIDC provider, adopted or created ---------------------------
#
# An account may hold only ONE provider per issuer URL, and by the time a second
# application is bootstrapped that provider usually already exists — created by
# another app, or by hand years ago. Creating it unconditionally fails with a
# 409 that rolls the whole stack back.
#
# So: discover first, create only if absent, and pass the ARN to step 2 as a
# parameter rather than via Fn::ImportValue. That decoupling is what lets the
# per-app stack deploy into an account whose provider we did not create.

log "Step 1/2: GitHub OIDC provider"
OIDC_ARN="$(aws_ iam list-open-id-connect-providers \
  --query "OpenIDConnectProviderList[?ends_with(Arn, ':oidc-provider/token.actions.githubusercontent.com')].Arn | [0]" \
  --output text 2>/dev/null || echo "None")"

if [ "${OIDC_ARN}" = "None" ] || [ -z "${OIDC_ARN}" ]; then
  sub "not present — creating it via CloudFormation"
  deploy github-oidc-baseline "${SCRIPT_DIR}/cfn/github-oidc.yaml"
  OIDC_ARN="$(output github-oidc-baseline OidcProviderArn)"
else
  sub "adopting the existing provider"
fi
sub "${OIDC_ARN}"

log "Step 2/2: Terraform state bucket + deployer role for '${APP_NAME}'"
# The OIDC trust matches on org and repo NAMES, never numeric ids, so the
# template needs them split rather than as one owner/repo string.
GITHUB_ORG="${GITHUB_REPO%%/*}"
REPOSITORY_NAME="${GITHUB_REPO##*/}"
deploy "${APP_NAME}-bootstrap" "${SCRIPT_DIR}/cfn/tfstate-bootstrap.yaml" \
  "AppName=${APP_NAME}" "GitHubOrg=${GITHUB_ORG}" "RepositoryName=${REPOSITORY_NAME}" \
  "OidcProviderArn=${OIDC_ARN}"

[ -n "${DRYRUN}" ] && { log "DRYRUN complete — execute the changesets to apply."; exit 0; }

# --- DNS precondition -------------------------------------------------------
# Read-only on purpose. Terraform looks the zone up by name at plan time
# (ADR-0008), so a missing zone surfaces as a confusing plan failure much later.
# Catching it here names the problem while the operator is still in the shell.
log "Checking the DNS apex '${DNS_APEX}' exists in this account"
ZONE_ID="$(aws_ route53 list-hosted-zones-by-name --dns-name "${DNS_APEX}" \
  --query "HostedZones[?Name=='${DNS_APEX}.'].Id | [0]" --output text 2>/dev/null || echo "None")"
if [ "${ZONE_ID}" = "None" ] || [ -z "${ZONE_ID}" ]; then
  sub "NOT FOUND — create a public hosted zone for ${DNS_APEX} and delegate it"
  sub "at the registrar BEFORE the first 'edge' stack apply."
else
  sub "found ${ZONE_ID##*/}"
  for entry in "${ENV_HOSTS[@]}"; do
    sub "  ${entry%%|*} -> ${entry##*|}"
  done
fi

cat <<EOF

==> Trust floor complete for '${APP_NAME}'. Every step above is idempotent.

  account        = ${ACCOUNT_ID}
  region         = ${REGION}
  tfstate bucket = $(output "${APP_NAME}-bootstrap" TfStateBucketName)
  deployer role  = $(output "${APP_NAME}-bootstrap" DeployerRoleArn)

  Next:
    make bootstrap-tags        activate Project/Environment cost allocation
    make github-environments   create dev/test/prod and their promotion gates
    make entra                 register the OAuth application

EOF
