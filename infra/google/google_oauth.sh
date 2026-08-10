#!/usr/bin/env bash
# Seed the Google OAuth client secret into each environment's SSM shell
# (ADR-0035), and print the redirect URIs that must be registered on the client.
#
# WHY THIS IS A SCRIPT AND NOT TERRAFORM:
#
# Same reason as `../entra/entra_app.sh`. The credential lives in a different
# cloud under a different identity, and managing it from here would mean the AWS
# deployer role also holding Google credentials — a cross-cloud privilege
# escalation for one resource that changes roughly never.
#
# WHY IT DOES LESS THAN THE ENTRA SCRIPT:
#
# `gcloud` has no supported command that creates an OAuth *web client* and
# returns its secret; that is a Cloud Console action. So the client is created by
# hand, its details land in `reference/gcloud-oauth.txt` (gitignored — see the
# reference/ note in CLAUDE.md), and this script does the one part that must be
# automated: putting the secret where the edge reads it, without it ever passing
# through Terraform state or a shell that echoes.
#
# Requires: the AWS credentials the rest of the bootstrap uses.
# Safe to re-run: it overwrites values and creates nothing.
#
# ENVS names which environments to seed, defaulting to all of them. It exists
# because the shells appear one environment at a time as a change is promoted —
# dev on the PR, test on merge, prod on the tag — so `ENVS=dev` is how Google
# sign-in gets tested in dev before test and prod exist. A named environment
# whose shell is missing is a hard error, never a skip: the whole point of
# naming it was to seed it.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../bootstrap/config.sh
source "${SCRIPT_DIR}/../bootstrap/config.sh"
# shellcheck source=../bootstrap/_common.sh
SCRIPT_DIR="${SCRIPT_DIR}/../bootstrap" source "${SCRIPT_DIR}/../bootstrap/_common.sh"

CREDENTIALS_FILE="${CREDENTIALS_FILE:-${SCRIPT_DIR}/../../reference/gcloud-oauth.txt}"

# Which environments to seed. Every known one unless ENVS narrows it.
TARGET_ENVS=()
for entry in "${ENV_HOSTS[@]}"; do TARGET_ENVS+=("${entry%%|*}"); done
if [ -n "${ENVS:-}" ]; then
  IFS=',' read -r -a TARGET_ENVS <<<"${ENVS}"
  for want in "${TARGET_ENVS[@]}"; do
    printf '%s\n' "${ENV_HOSTS[@]}" | grep -q "^${want}|" ||
      die "unknown environment '${want}' — expected one of: ${ENV_HOSTS[*]%%|*}"
  done
fi

# --- The redirect URIs -------------------------------------------------------
# Every admitted hostname must be registered on the client, because the OAuth
# redirect follows the VIEWER's host rather than a single configured one. Miss
# one and that environment fails at the callback with `redirect_uri_mismatch`.

log "Authorized redirect URIs to register on the Google client"
for entry in "${ENV_HOSTS[@]}"; do
  sub "https://${entry##*|}/oauth2/callback"
done
# The local development host, so `make dev` can exercise the real flow.
sub "http://localhost:5173/oauth2/callback"

# --- The secret --------------------------------------------------------------
# Read from the credentials file and written STRAIGHT into SSM, never echoed.
# Terraform creates the parameter as a shell holding "UNSEEDED" and ignores
# changes to its value, so this is the only writer.

[ -f "${CREDENTIALS_FILE}" ] ||
  die "${CREDENTIALS_FILE} not found. It holds client_id= and client_secret= from the Cloud Console."

CLIENT_ID="$(sed -n 's/^client_id=//p' "${CREDENTIALS_FILE}" | head -1)"
SECRET="$(sed -n 's/^client_secret=//p' "${CREDENTIALS_FILE}" | head -1)"

[ -n "${CLIENT_ID}" ] || die "no client_id= line in ${CREDENTIALS_FILE}"
[ -n "${SECRET}" ] || die "no client_secret= line in ${CREDENTIALS_FILE}"

log "Seeding the client secret into: ${TARGET_ENVS[*]}"
for env_name in "${TARGET_ENVS[@]}"; do
  param="/${APP_NAME}/${env_name}/auth/google/client_secret"

  # The shell MUST already exist, created by the identity stack. This script
  # only ever overwrites a value; it never creates the parameter.
  #
  # That ordering is not fussiness — it is the fix for a real failure the Entra
  # script already hit. Run the other way round, this script creates the
  # parameter and the identity stack's next apply dies with
  # `ParameterAlreadyExists`, permanently, because Terraform will not adopt a
  # resource it did not create. Failing loudly here costs one clear message; the
  # alternative costs a state import.
  if ! aws_ ssm get-parameter --name "${param}" >/dev/null 2>&1; then
    die "${param} does not exist yet. Apply the identity stack for '${env_name}' first (make cold-start ENV=${env_name}), then re-run this."
  fi

  aws_ ssm put-parameter \
    --name "${param}" \
    --value "${SECRET}" --type SecureString --overwrite >/dev/null
  sub "seeded ${param}"
done

unset SECRET

cat <<EOF

==> Google sign-in seeded.

  client id = ${CLIENT_ID}

  Confirm it matches 'google_client_id' in infra/stacks/identity/config.yml,
  then let CI apply the identity stack. The edge offers Google only once the
  secret above is seeded, so an unapplied environment shows one provider rather
  than a button that fails at the token exchange.

EOF
