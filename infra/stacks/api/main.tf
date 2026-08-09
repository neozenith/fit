# Stack: api — the request handler for one environment.
#
# NO `resource` blocks.
#
# Deploys many times a day, which is the whole reason it is separate from
# `edge` (a distribution change takes 15 minutes to propagate) and from `data`
# (a table with deletion protection should not appear in an app-deploy plan).
#
# Reads its upstream identifiers from SSM rather than from sibling state
# (ADR-0008): the reader needs IAM on a parameter prefix, not the writer's
# backend credentials.

data "aws_ssm_parameter" "table_arn" {
  for_each = toset(["blocks", "sets", "measurements", "cardio", "season"])
  name     = "/${local.app_name}/${var.environment}/data/table/${each.key}"
}

data "aws_ssm_parameter" "archive_bucket" {
  name = "/${local.app_name}/${var.environment}/data/archive_bucket"
}

locals {
  region     = local.config.region
  account_id = data.aws_caller_identity.current.account_id

  # SSM stores the table NAME; the IAM policy needs the ARN. Reconstructing it
  # here rather than storing both keeps one source of truth for the name.
  table_arns = {
    for k, p in data.aws_ssm_parameter.table_arn :
    k => "arn:aws:dynamodb:${local.config.region}:${data.aws_caller_identity.current.account_id}:table/${p.value}"
  }
}

module "api" {
  source = "../../modules/api"

  app_name    = local.app_name
  environment = var.environment
  name_prefix = local.name_prefix
  account_id  = local.account_id
  region      = local.region

  bundle_dir       = var.bundle_dir
  duckdb_layer_dir = var.duckdb_layer_dir

  table_arns         = local.table_arns
  archive_bucket     = data.aws_ssm_parameter.archive_bucket.value
  archive_bucket_arn = "arn:aws:s3:::${data.aws_ssm_parameter.archive_bucket.value}"

  # Reconstructed by convention rather than read from the global stack's state
  # or its SSM parameters, so an environment can deploy before the FinOps stack
  # has ever run. Reading `/fit/global/finops/bucket` here would make every
  # environment's API deploy depend on a stack it does not own — the API page
  # then reports "no cost data" instead of failing the whole apply.
  finops_bucket     = "${local.app_name}-finops-${local.account_id}"
  finops_bucket_arn = "arn:aws:s3:::${local.app_name}-finops-${local.account_id}"
  finops_prefix     = local.config.finops.prefix
}
