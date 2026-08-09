# Stack: finops — account-wide cost reporting, deployed once.
#
# NO `resource` blocks.
#
# Applies on merge to `main` only. It has no environment to promote through, so
# a change is verified in the same place it lands — acceptable because the stack
# is read-only reporting over data it does not own. The FinOps *page* is
# application code and still ships through the normal promotion path.

module "finops" {
  source = "../../modules/finops"

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  app_name      = local.config.app_name
  name_prefix   = local.name_prefix
  account_id    = data.aws_caller_identity.current.account_id
  bucket_region = local.config.region
}
