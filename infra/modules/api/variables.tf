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

variable "duckdb_layer_dir" {
  description = <<-EOT
    Directory holding the built DuckDB layer, zipped at plan time.

    Produced by tools/build-duckdb-layer.sh and nothing else. The query path
    imports DuckDB at module scope, so a missing or wrong-architecture layer
    fails at cold start rather than on the first cost query.
  EOT
  type        = string
}
