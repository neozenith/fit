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
variable "glue_database" { type = string }
variable "athena_workgroup" { type = string }

variable "finops_database" {
  description = "Glue database of the global FinOps stack. Same value in every environment (ADR-0015)."
  type        = string
  default     = ""
}

variable "finops_workgroup" {
  description = "Athena workgroup of the global FinOps stack."
  type        = string
  default     = ""
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
