#!/usr/bin/env bash
# Platform identity for the bootstrap drivers. Source-only; do not execute.
#
# This is the ONLY file that names a specific account, profile, region or DNS
# apex. The CloudFormation templates and the drivers are fully generic, so
# standing this platform up somewhere else means editing this file and nothing
# else.
#
# Nothing here is a secret: the profile name is a local alias, and the account
# id is derived from the caller's credentials at runtime.

# AWS profile for the target account. Leave EMPTY to use ambient credentials
# (an active SSO session, or a role assumed via OIDC in CI).
#
# Two subtleties, both of which caused a real failure:
#
#   1. `${VAR-default}` rather than `${VAR:-default}`. The colon form treats an
#      explicitly-EMPTY value as unset and substitutes the default anyway — so a
#      workflow setting `AWS_PROFILE: ""` to mean "use ambient credentials" got
#      `fullsend-jpai` instead, and every AWS call failed with "config profile
#      could not be found".
#
#   2. Under CI there is never a profile, whatever anything says. A runner has
#      OIDC-assumed credentials in the environment and no `~/.aws/config` at
#      all, so naming a profile can only break it.
if [ -n "${GITHUB_ACTIONS:-}${CI:-}" ]; then
  APP_PROFILE=""
else
  APP_PROFILE="${AWS_PROFILE-fullsend-jpai}"
fi

# Region for regional resources (ADR-0017). The certificate, the edge function
# and the Cost and Usage Report live in us-east-1 regardless — AWS gives no
# choice — and the Terraform stacks declare that as an aliased provider.
REGION="${AWS_REGION:-ap-southeast-2}"

# The DNS apex the environments hang off. Expected to ALREADY exist as a public
# hosted zone in this account; the bootstrap verifies it rather than creating
# it, because a zone it created would carry nameservers nobody has delegated to.
DNS_APEX="${DNS_APEX:-jpeak.ai}"

# Environment hostnames, for the verification step and for operator output.
# Kept here rather than in the templates so the trust floor stays generic.
ENV_HOSTS=(
  "dev|fit-dev.${DNS_APEX}"
  "test|fit-test.${DNS_APEX}"
  "prod|fit.${DNS_APEX}"
)

# owner/repo and the app slug are DERIVED from the enclosing git repo by
# _common.sh. Override here only if the git remote is not the deploying repo.
# GITHUB_REPO="neozenith/fit"
# APP_NAME="fit"
