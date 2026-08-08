terraform {
  required_version = ">= 1.9.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.60.0"
      # The certificate and the edge function MUST be created in us-east-1
      # (ADR-0017), so this module requires the caller to pass an aliased
      # provider alongside the default one.
      configuration_aliases = [aws.us_east_1]
    }
    archive = {
      source  = "hashicorp/archive"
      version = ">= 2.4.0"
    }
  }
}
