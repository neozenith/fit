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

variable "athena_scan_limit_bytes" {
  description = <<-EOT
    Per-query byte ceiling. Higher than the application workgroup's because a
    cost query legitimately scans more than a training log does, but still
    bounded so a missing WHERE clause costs cents rather than dollars.
  EOT
  type        = number
  default     = 10737418240 # 10 GiB
}
