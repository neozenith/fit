# Stack: edge — the front door for one environment.
#
# NO `resource` blocks.
#
# Reads the API's identifiers from SSM. That direction is deliberate and is the
# reason the CloudFront-to-Lambda invoke permission lives in the edge module:
# the reverse would make `api` and `edge` mutually dependent.

data "aws_ssm_parameter" "api_function_url" {
  name = "/${local.app_name}/${var.environment}/api/function_url"
}

module "edge" {
  source = "../../modules/edge"

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  app_name    = local.app_name
  environment = var.environment
  name_prefix = local.name_prefix
  account_id  = data.aws_caller_identity.current.account_id

  # The region the SSM parameters live in — NOT where the edge function runs.
  # The function runs wherever the viewer is, so its SSM client must be pinned.
  region = local.config.region

  fqdn        = local.env.fqdn
  extra_hosts = local.env.extra_hosts
  zone_id     = data.aws_route53_zone.apex.zone_id

  api_function_url  = data.aws_ssm_parameter.api_function_url.value
  api_function_name = "${local.name_prefix}-api"
}
