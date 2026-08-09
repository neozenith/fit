variable "app_name" {
  description = "Application slug. Prefixes SSM parameter paths."
  type        = string
}

variable "environment" {
  description = "dev | test | prod. Selects deletion protection and naming."
  type        = string
}

variable "name_prefix" {
  description = "Resource name prefix, conventionally {app_name}-{environment}."
  type        = string
}

variable "account_id" {
  description = "AWS account id. Suffixes the archive bucket, which is globally unique."
  type        = string
}

