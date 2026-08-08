# Stack: archive — the age-out job for one environment.
#
# NO `resource` blocks.
#
# Separate from `data` because it changes on a different rhythm: a retention
# policy moves rarely, and a table with deletion protection should not appear in
# a plan just because a schedule expression changed (ADR-0008).

data "aws_ssm_parameter" "archive_bucket" {
  name = "/${local.app_name}/${var.environment}/data/archive_bucket"
}

data "aws_ssm_parameter" "glue_database" {
  name = "/${local.app_name}/${var.environment}/data/glue_database"
}

module "archive" {
  source = "../../modules/archive"

  app_name    = local.app_name
  environment = var.environment
  name_prefix = local.name_prefix
  account_id  = data.aws_caller_identity.current.account_id
  region      = local.config.region

  archive_bucket     = data.aws_ssm_parameter.archive_bucket.value
  archive_bucket_arn = "arn:aws:s3:::${data.aws_ssm_parameter.archive_bucket.value}"
  glue_database      = data.aws_ssm_parameter.glue_database.value

  hot_window_months = local.env.hot_window_months
  pyarrow_layer_arn = local.config.pyarrow_layer_arn
}
