# Stack: identity — the credential surface for one environment.
#
# NO `resource` BLOCKS. A stack composes modules and owns naming, environment
# selection and wiring; a module owns resources. Check yourself:
#
#   grep -rn '^resource' infra/stacks/     # must return nothing
#
# Deployed first: everything else reads the parameters it publishes.

module "identity" {
  source = "../../modules/identity"

  app_name    = local.app_name
  environment = var.environment
  fqdn        = local.env.fqdn

  entra_tenant_id  = local.config.entra_tenant_id
  entra_client_id  = local.env.entra_client_id
  google_client_id = local.config.google_client_id

  allowed_users = local.env.allowed_users

  session_ttl_seconds = local.env.session_ttl_seconds
}
