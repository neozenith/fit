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
  }
}

locals {
  config = yamldecode(file("${path.module}/config.yml"))

  # No environment segment anywhere in this stack. It is global by construction
  # (ADR-0015), and adding one would imply three copies of account-scoped data.
  name_prefix = "${local.config.app_name}-finops"

  common_tags = {
    Project = local.config.app_name
    # `global`, not a real environment. The FinOps stack's OWN cost has to land
    # somewhere in its own report, and attributing it to dev or prod would be a
    # lie that then shows up in the very chart it produces.
    Environment = "global"
    Stack       = "finops"
    ManagedBy   = "terraform"
  }
}

provider "aws" {
  region = local.config.region
  default_tags {
    tags = local.common_tags
  }
}

# The Cost and Usage Report definition can only be created here (ADR-0017).
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
  default_tags {
    tags = local.common_tags
  }
}

data "aws_caller_identity" "current" {}
