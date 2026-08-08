variable "app_name" { type = string }
variable "environment" { type = string }
variable "name_prefix" { type = string }
variable "account_id" { type = string }
variable "region" { type = string }

variable "archive_bucket" { type = string }
variable "archive_bucket_arn" { type = string }
variable "glue_database" { type = string }

variable "hot_window_months" {
  description = <<-EOT
    How much history stays in DynamoDB. Thirteen in the deployed environments,
    not twelve, so a year-on-year comparison is always answerable from the hot
    path alone and never has to reach Athena (ADR-0012).
  EOT
  type        = number
  default     = 13
}

variable "aged_tables" {
  description = <<-EOT
    Logical tables the job may scan and delete from. Observation tables only —
    `blocks` and `season` are configuration, are small, and are always hot, so
    moving them would save nothing and cost a join.
  EOT
  type        = list(string)
  default     = ["sets", "measurements", "cardio"]
}

variable "pyarrow_layer_arn" {
  description = <<-EOT
    Lambda layer providing pyarrow. Required, with no default and no fallback:
    the handler imports pyarrow at module scope precisely so a missing layer
    fails at cold start rather than silently skipping the Parquet write and
    deleting DynamoDB items with nothing written in their place.
  EOT
  type        = string

  validation {
    condition     = can(regex("^arn:aws:lambda:", var.pyarrow_layer_arn))
    error_message = "pyarrow_layer_arn must be a Lambda layer ARN."
  }
}
