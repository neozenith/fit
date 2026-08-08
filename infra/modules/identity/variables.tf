variable "app_name" {
  description = "Application slug. Prefixes every SSM parameter path."
  type        = string
}

variable "environment" {
  description = "dev | test | prod."
  type        = string
}

variable "fqdn" {
  description = "Canonical hostname for this environment. Any other Host is rejected with 421."
  type        = string
}

variable "entra_tenant_id" {
  description = "EntraID directory (tenant) id. A token whose `tid` differs is refused."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", var.entra_tenant_id))
    error_message = "entra_tenant_id must be a lowercase GUID."
  }
}

variable "entra_client_id" {
  description = "EntraID application (client) id."
  type        = string
}

variable "allowed_users" {
  description = <<-EOT
    Email addresses admitted after the tenant check passes. An empty list
    admits NOBODY — the fail-closed direction — because the tenant check alone
    would let in every account in the directory (ADR-0010).
  EOT
  type        = list(string)

  validation {
    condition     = length(var.allowed_users) > 0
    error_message = "allowed_users must name at least one address; an empty list locks everyone out."
  }
}

variable "session_ttl_seconds" {
  description = "Lifetime of a human sign-in session."
  type        = number
  default     = 28800 # 8 hours
}
