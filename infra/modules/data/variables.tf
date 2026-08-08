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

variable "athena_scan_limit_bytes" {
  description = <<-EOT
    Per-query byte ceiling for the app's Athena workgroup. Every legitimate
    query here is partition-pruned to a few months of Parquet, so a low cap is
    the cheapest possible guard against an accidental full-archive scan.
  EOT
  type        = number
  default     = 1073741824 # 1 GiB
}
