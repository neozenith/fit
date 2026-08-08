#!/usr/bin/env bash
# Create the GitHub Environments that gate deployment, and wire the deployer
# role into them (ADR-0007).
#
# The gates, and why each is where it is:
#
#   dev   any branch. A ready-for-review pull request applies here, so it must
#         not require a human — the whole point is a pre-merge smoke test.
#   test  protected: `main` only. Merging is the promotion event.
#   prod  protected: tags matching v* only. A tag is a deliberate, named act.
#
# `plan` jobs bind NO environment on purpose. Plans run for all three
# environments on every trigger (including pull requests), and a `plan / prod`
# job on a PR branch would be rejected by prod's own tag gate. Plans take the
# deployer role from the repository-level variable instead; only APPLY jobs
# bind `environment:`, so the gates constrain exactly where state is mutated.
#
# Requires: gh authenticated with repo admin. Safe to re-run.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./config.sh
source "${SCRIPT_DIR}/config.sh"
# shellcheck source=./_common.sh
source "${SCRIPT_DIR}/_common.sh"

command -v gh >/dev/null || die "gh not found — install the GitHub CLI"
gh auth status >/dev/null 2>&1 || die "gh not authenticated — run 'gh auth login'"

# The role ARN is rebuilt BY CONVENTION rather than read from the bootstrap
# stack's outputs. That keeps this script independent of CloudFormation, at the
# cost of one real hazard: if the bootstrap never ran, this happily sets a
# variable pointing at a role that does not exist, and the first CI run fails
# with an unhelpful AssumeRole error. So verify it.
ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${APP_NAME}-github-deployer"

log "Verifying the deployer role exists before advertising it"
aws_ iam get-role --role-name "${APP_NAME}-github-deployer" >/dev/null 2>&1 \
  || die "role ${ROLE_ARN} not found — run 'make bootstrap' first"
sub "${ROLE_ARN}"

log "Repository variables on ${GITHUB_REPO}"
# Repo-level, because the plan jobs cannot bind an environment (see header).
gh variable set AWS_ROLE_ARN --repo "${GITHUB_REPO}" --body "${ROLE_ARN}"
gh variable set AWS_REGION   --repo "${GITHUB_REPO}" --body "${REGION}"
gh variable set APP_NAME     --repo "${GITHUB_REPO}" --body "${APP_NAME}"
sub "AWS_ROLE_ARN, AWS_REGION, APP_NAME"

log "Environments and promotion gates"
for entry in "${ENV_HOSTS[@]}"; do
  env_name="${entry%%|*}"
  env_host="${entry##*|}"

  # `gh api --method PUT` on the environment endpoint is create-or-update.
  gh api --method PUT "repos/${GITHUB_REPO}/environments/${env_name}" \
    --silent >/dev/null

  case "${env_name}" in
    dev)
      # No branch policy: any branch may deploy. Deliberate.
      gh api --method PUT "repos/${GITHUB_REPO}/environments/${env_name}" \
        -F "deployment_branch_policy=null" --silent >/dev/null
      sub "dev   — any branch (a ready-for-review PR applies here)"
      ;;
    test)
      gh api --method PUT "repos/${GITHUB_REPO}/environments/${env_name}" \
        -F "deployment_branch_policy[protected_branches]=false" \
        -F "deployment_branch_policy[custom_branch_policies]=true" --silent >/dev/null
      gh api --method POST \
        "repos/${GITHUB_REPO}/environments/${env_name}/deployment-branch-policies" \
        -f "name=main" -f "type=branch" --silent >/dev/null 2>&1 || true
      sub "test  — main only"
      ;;
    prod)
      gh api --method PUT "repos/${GITHUB_REPO}/environments/${env_name}" \
        -F "deployment_branch_policy[protected_branches]=false" \
        -F "deployment_branch_policy[custom_branch_policies]=true" --silent >/dev/null
      gh api --method POST \
        "repos/${GITHUB_REPO}/environments/${env_name}/deployment-branch-policies" \
        -f "name=v*" -f "type=tag" --silent >/dev/null 2>&1 || true
      sub "prod  — v* tags only"
      ;;
  esac

  gh variable set APP_HOST --repo "${GITHUB_REPO}" --env "${env_name}" --body "${env_host}"
done

cat <<EOF

==> Delivery gates converged on ${GITHUB_REPO}.

  dev   https://fit-dev.${DNS_APEX}    any branch
  test  https://fit-test.${DNS_APEX}   main only
  prod  https://fit.${DNS_APEX}        v* tags only

  Add required reviewers to the prod environment in the repository settings if
  you want a human approval on top of the tag gate.

EOF
