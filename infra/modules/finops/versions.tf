terraform {
  required_version = ">= 1.9.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.60.0"
      # The Cost and Usage Report definition can only be created in us-east-1
      # (ADR-0017), so the caller must pass an aliased provider for it.
      configuration_aliases = [aws.us_east_1]
    }
  }
}
