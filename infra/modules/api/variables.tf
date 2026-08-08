variable "app_name" { type = string }
variable "environment" { type = string }
variable "name_prefix" { type = string }
variable "account_id" { type = string }
variable "region" { type = string }

variable "bundle_dir" {
  description = "Directory holding the built handler. Zipped at plan time by archive_file."
  type        = string
}

variable "table_arns" {
  description = "Logical table name -> ARN, from the data module."
  type        = map(string)
}

variable "archive_bucket" { type = string }
variable "archive_bucket_arn" { type = string }

variable "finops_bucket" {
  description = "Bucket holding the CUR export. Same value in every environment (ADR-0015)."
  type        = string
  default     = ""
}

variable "finops_prefix" {
  description = "Prefix beneath which the export lands. Globbed by DuckDB; there is no catalogue (ADR-0025)."
  type        = string
  default     = "cur"
}

variable "finops_bucket_arn" {
  description = <<-EOT
    CUR bucket ARN. Empty when the global FinOps stack has not been applied
    yet — the read grant is then omitted entirely rather than being written
    with a placeholder that would silently never match.
  EOT
  type        = string
  default     = ""
}

variable "duckdb_layer_arn" {
  description = <<-EOT
    Lambda layer providing DuckDB, built for linux-arm64.

    Required, with no default: the query path imports it at module scope so a
    missing or wrong-architecture layer fails at cold start rather than on the
    first cost query. `npm` and `bun` resolve the native binding for the BUILD
    HOST, so this layer must be built in CI on linux-arm64 — one built on a
    laptop ships a darwin binary and fails with a module-resolution error.
  EOT
  type        = string

  validation {
    condition     = can(regex("^arn:aws:lambda:", var.duckdb_layer_arn))
    error_message = "duckdb_layer_arn must be a Lambda layer ARN."
  }
}
