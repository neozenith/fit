terraform {
  required_version = ">= 1.9.0"

  backend "s3" {
    use_lockfile = true
    encrypt      = true
  }

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.60.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = ">= 2.4.0"
    }
  }
}

locals {
  config      = yamldecode(file("${path.module}/config.yml"))
  env         = local.config.environments[var.environment]
  app_name    = local.config.app_name
  name_prefix = "${local.config.app_name}-${var.environment}"

  common_tags = {
    Project     = local.config.app_name
    Environment = var.environment
    Stack       = "edge"
    ManagedBy   = "terraform"
  }
}

provider "aws" {
  region = local.config.region
  default_tags {
    tags = local.common_tags
  }
}

# The certificate and the Lambda@Edge function have no choice about their
# region (ADR-0017). CloudFront reads certificates only from us-east-1, and
# edge functions are only creatable there.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
  default_tags {
    tags = local.common_tags
  }
}

data "aws_caller_identity" "current" {}

# Looked up BY NAME rather than wired from a sibling stack (ADR-0008). The zone
# is older than this platform and is not owned by any stack in it, so making a
# stack the source of truth for it would be a lie that eventually gets applied.
data "aws_route53_zone" "apex" {
  name         = local.config.dns_apex
  private_zone = false
}
