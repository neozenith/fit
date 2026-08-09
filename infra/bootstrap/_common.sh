#!/usr/bin/env bash
# Shared helpers for the bootstrap drivers. Source-only, AFTER config.sh.
# Nothing here names a platform.
#
# Provides: PROFILE_ARGS, GITHUB_REPO, APP_NAME, ACCOUNT_ID, and the
# log/sub/deploy/output helpers. Expects SCRIPT_DIR from the caller and REGION
# from config.sh. Honours DRYRUN.

: "${REGION:?set in config.sh}"
export AWS_DEFAULT_REGION="${REGION}"
DRYRUN="${DRYRUN:-}"

# --profile is optional: an empty APP_PROFILE means "use ambient credentials".
PROFILE_ARGS=()
if [ -n "${APP_PROFILE:-}" ]; then
  PROFILE_ARGS=(--profile "${APP_PROFILE}")
else
  # UNSET, not empty. An empty `AWS_PROFILE` is not the same as an unset one to
  # the AWS CLI: it dutifully looks for a profile named "" and dies with
  # "The config profile () could not be found". A workflow step writing
  # `AWS_PROFILE: ""` to mean "use the ambient OIDC credentials" therefore broke
  # every call it made — the opposite of what it was asking for.
  #
  # This is the sibling of the `${VAR-default}` note in config.sh: there, an
  # empty value was wrongly treated as unset; here, an empty value must BE
  # unset. Clearing it once at the source covers every caller.
  unset AWS_PROFILE
fi

# App identity, derived from the enclosing git repo unless config.sh overrode it.
GITHUB_REPO="${GITHUB_REPO:-$(git -C "${SCRIPT_DIR}" remote get-url origin \
  | sed -E 's#(git@github.com:|https://github.com/)##; s#\.git$##')}"
APP_NAME="${APP_NAME:-${GITHUB_REPO##*/}}"

log() { printf '\n==> %s\n' "$*"; }
sub() { printf '    - %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

aws_() { aws "${PROFILE_ARGS[@]+"${PROFILE_ARGS[@]}"}" "$@"; }

# deploy <stack> <template> [Key=Value...]
deploy() {
  local stack="$1" template="$2"; shift 2
  local extra=()
  [ "$#" -gt 0 ] && extra=(--parameter-overrides "$@")
  # The ${arr[@]+...} form: macOS ships bash 3.2, where expanding an empty
  # array under `set -u` is an error rather than an empty expansion.
  if [ -n "${DRYRUN}" ]; then
    aws_ cloudformation deploy --stack-name "${stack}" \
      --template-file "${template}" --capabilities CAPABILITY_NAMED_IAM \
      --no-execute-changeset ${extra[@]+"${extra[@]}"} || true
    sub "DRYRUN: changeset created for ${stack}, not executed"
  else
    aws_ cloudformation deploy --stack-name "${stack}" \
      --template-file "${template}" --capabilities CAPABILITY_NAMED_IAM \
      --no-fail-on-empty-changeset \
      --tags Project="${APP_NAME}" ManagedBy=bootstrap \
      ${extra[@]+"${extra[@]}"}
  fi
}

# output <stack> <OutputKey>
output() {
  aws_ cloudformation describe-stacks --stack-name "$1" \
    --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text
}

ACCOUNT_ID="$(aws_ sts get-caller-identity --query Account --output text)" \
  || die "cannot reach AWS with profile '${APP_PROFILE:-<ambient>}' — check your credentials"
