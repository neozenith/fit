variable "app_name" { type = string }

variable "name_prefix" {
  description = "Conventionally {app_name}-finops. There is no environment segment — this stack is global (ADR-0015)."
  type        = string
}

variable "account_id" { type = string }

variable "bucket_region" {
  description = "Region the CUR bucket lives in. The EXPORT definition is us-east-1 regardless; only the bucket has a choice."
  type        = string
}

