terraform {
  required_version = ">= 1.9.0"

  # PARTIAL backend (ADR-0005). Every value below that is absent — bucket, key,
  # region — arrives from `backends/<env>.config` at `terraform init`, passed by
  # CI. Consequence: a local terraform command reads whichever environment was
  # last initialised, which is precisely why `make tf-check` uses
  # `-backend=false` and why applying locally is forbidden (ADR-0006).
  backend "s3" {
    # S3-native locking. There is no DynamoDB lock table to create, pay for, or
    # forget to clean up.
    use_lockfile = true
    encrypt      = true
  }

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.60.0"
    }
  }
}

locals {
  config      = yamldecode(file("${path.module}/config.yml"))
  env         = local.config.environments[var.environment]
  app_name    = local.config.app_name
  name_prefix = "${local.config.app_name}-${var.environment}"

  # Attached to every resource this stack creates. `Project` and `Environment`
  # are what the FinOps page groups by, and they are NOT retroactive — a
  # resource created without them is unattributable forever (ADR-0014).
  common_tags = {
    Project     = local.config.app_name
    Environment = var.environment
    Stack       = "api"
    ManagedBy   = "terraform"
  }
}

provider "aws" {
  region = local.config.region
  default_tags {
    tags = local.common_tags
  }
}

data "aws_caller_identity" "current" {}
