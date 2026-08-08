# Stack: data — the durable stores for one environment.
#
# NO `resource` blocks: modules own resources, stacks own wiring.
#
# Changes rarely (a table is added, a retention window moves), which is exactly
# why it is its own stack — an API deploy several times a day must not re-plan
# a DynamoDB table with deletion protection on it (ADR-0008).

module "data" {
  source = "../../modules/data"

  app_name    = local.app_name
  environment = var.environment
  name_prefix = local.name_prefix
  account_id  = data.aws_caller_identity.current.account_id

  athena_scan_limit_bytes = local.env.athena_scan_limit_bytes
}
