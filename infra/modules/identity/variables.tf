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

variable "google_client_id" {
  description = <<-EOT
    Google OAuth web-application client id. One credential serves every
    environment, with every environment's redirect URI registered on it — the
    same reasoning as the single EntraID registration (ADR-0035).
  EOT
  type        = string

  validation {
    condition     = can(regex("\\.apps\\.googleusercontent\\.com$", var.google_client_id))
    error_message = "google_client_id must be a *.apps.googleusercontent.com identifier."
  }
}

variable "allowed_users" {
  description = <<-EOT
    Email addresses admitted after the provider's own check passes — Entra's
    tenant check, Google's `email_verified`. ONE list across providers: an
    address is admitted whoever vouches for it. An empty list admits NOBODY —
    the fail-closed direction — because the provider check alone would let in
    every account the provider will vouch for (ADR-0010, ADR-0035).
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
