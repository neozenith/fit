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

data "aws_ssm_parameter" "glue_database" {
  name = "/${local.app_name}/${var.environment}/data/glue_database"
}

data "aws_ssm_parameter" "athena_workgroup" {
  name = "/${local.app_name}/${var.environment}/data/athena_workgroup"
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

  bundle_dir = var.bundle_dir

  table_arns         = local.table_arns
  archive_bucket     = data.aws_ssm_parameter.archive_bucket.value
  archive_bucket_arn = "arn:aws:s3:::${data.aws_ssm_parameter.archive_bucket.value}"
  glue_database      = data.aws_ssm_parameter.glue_database.value
  athena_workgroup   = data.aws_ssm_parameter.athena_workgroup.value

  finops_database  = local.config.finops.glue_database
  finops_workgroup = local.config.finops.athena_workgroup
  # Reconstructed by convention rather than read from the global stack, so an
  # environment can deploy before the FinOps stack has ever run. The module
  # omits the grant entirely when this is empty.
  finops_bucket_arn = "arn:aws:s3:::${local.app_name}-finops-${local.account_id}"
}
