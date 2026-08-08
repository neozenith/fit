#!/usr/bin/env bash
# Create or converge the EntraID application registration used for OAuth
# (ADR-0010), and seed its client secret into each environment's SSM shell.
#
# WHY THIS IS A SCRIPT AND NOT TERRAFORM:
#
# The registration lives in a different cloud to everything else, under a
# different identity. Terraform *can* manage it with the azuread provider, but
# that means the AWS deployer role also holding Entra credentials — a
# cross-cloud privilege escalation for one resource that changes roughly never.
#
# ONE registration serves all three environments, with all three redirect URIs.
# Three registrations would mean three secrets to rotate and three consent
# grants, to separate environments that share a single directory and a single
# admitted user anyway. Environments are separated by their allow-list and their
# own signing key, not by their IdP registration.
#
# Requires: az logged in with permission to create app registrations.
# Safe to re-run: it converges rather than duplicating.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../bootstrap/config.sh
source "${SCRIPT_DIR}/../bootstrap/config.sh"
# shellcheck source=../bootstrap/_common.sh
SCRIPT_DIR="${SCRIPT_DIR}/../bootstrap" source "${SCRIPT_DIR}/../bootstrap/_common.sh"

APP_DISPLAY_NAME="${APP_DISPLAY_NAME:-fit}"

command -v az >/dev/null || die "az not found — install the Azure CLI"
az account show >/dev/null 2>&1 || die "az not logged in — run 'az login'"

TENANT_ID="$(az account show --query tenantId -o tsv)"

log "Tenant ${TENANT_ID}"

# Every admitted hostname must be a registered redirect URI, because the OAuth
# redirect follows the VIEWER's host rather than a single configured one. Miss
# one and that environment fails at the callback with an opaque provider error.
REDIRECT_URIS=()
for entry in "${ENV_HOSTS[@]}"; do
  REDIRECT_URIS+=("https://${entry##*|}/oauth2/callback")
done
# The local development host, so `make dev` can exercise the real flow.
REDIRECT_URIS+=("http://localhost:5173/oauth2/callback")

log "Redirect URIs"
for uri in "${REDIRECT_URIS[@]}"; do sub "${uri}"; done

# --- The registration --------------------------------------------------------

APP_ID="$(az ad app list --display-name "${APP_DISPLAY_NAME}" \
  --query "[?displayName=='${APP_DISPLAY_NAME}'].appId | [0]" -o tsv 2>/dev/null || true)"

if [ -z "${APP_ID}" ] || [ "${APP_ID}" = "null" ]; then
  log "Creating app registration '${APP_DISPLAY_NAME}'"
  APP_ID="$(az ad app create \
    --display-name "${APP_DISPLAY_NAME}" \
    --sign-in-audience AzureADMyOrg \
    --web-redirect-uris "${REDIRECT_URIS[@]}" \
    --enable-id-token-issuance true \
    --query appId -o tsv)"
  sub "created ${APP_ID}"
else
  log "Converging existing registration ${APP_ID}"
  az ad app update --id "${APP_ID}" \
    --web-redirect-uris "${REDIRECT_URIS[@]}" \
    --enable-id-token-issuance true
  sub "redirect URIs updated"
fi

# A service principal in this tenant is what makes the app assignable and
# consentable. Creating the registration alone leaves sign-in failing with
# "application not found in directory", which does not obviously mean this.
if ! az ad sp show --id "${APP_ID}" >/dev/null 2>&1; then
  log "Creating the service principal"
  az ad sp create --id "${APP_ID}" >/dev/null
  sub "created"
fi

# --- The secret --------------------------------------------------------------
# Written STRAIGHT into SSM and never echoed. Terraform creates the parameter as
# a shell holding "UNSEEDED" and ignores changes to its value, so this is the
# only writer — and the edge returns a 500 naming the parameter while it is
# still unseeded, which makes a skipped run loud rather than mysterious.

if [ -n "${SKIP_SECRET:-}" ]; then
  log "SKIP_SECRET set — leaving existing secrets alone"
else
  log "Minting a client secret and seeding it into each environment"
  # Two years: long enough not to be a recurring chore, short enough that it is
  # not effectively permanent. Expiry is a calendar event, not a surprise.
  SECRET="$(az ad app credential reset --id "${APP_ID}" \
    --display-name "fit-$(date -u +%Y%m)" --years 2 \
    --query password -o tsv)"

  for entry in "${ENV_HOSTS[@]}"; do
    env_name="${entry%%|*}"
    param="/${APP_NAME}/${env_name}/auth/entra/client_secret"

    # The shell MUST already exist, created by the identity stack. This script
    # only ever overwrites a value; it never creates the parameter.
    #
    # That ordering is not fussiness — it is the fix for a real failure. Run
    # the other way round, this script creates the parameter and the identity
    # stack's next apply dies with `ParameterAlreadyExists`, permanently,
    # because Terraform will not adopt a resource it did not create. Failing
    # loudly here costs one clear message; the alternative costs a state import.
    if ! aws_ ssm get-parameter --name "${param}" >/dev/null 2>&1; then
      die "${param} does not exist yet. Apply the identity stack for '${env_name}' first (make cold-start ENV=${env_name}), then re-run this."
    fi

    aws_ ssm put-parameter \
      --name "${param}" \
      --value "${SECRET}" --type SecureString --overwrite >/dev/null
    sub "seeded ${param}"
  done

  unset SECRET
fi

cat <<EOF

==> EntraID registration converged.

  tenant id  = ${TENANT_ID}
  client id  = ${APP_ID}

  Put the client id into infra/stacks/identity/config.yml — every environment
  block's 'entra_client_id' — then let CI apply the identity stack:

    entra_client_id: "${APP_ID}"

  The secret has already been seeded into SSM for every environment and was
  never printed. Re-run with SKIP_SECRET=1 to converge redirect URIs without
  rotating it.

EOF
