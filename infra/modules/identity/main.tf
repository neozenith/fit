# module: identity — the credential surface, and nothing else.
#
# Two kinds of parameter live here, and the distinction is the whole design:
#
#   GENERATED — Terraform creates the value and owns it. The session HMAC key
#   is the only one. It is also the agentic test key (ADR-0011), so access to
#   it IS access to a test session, and that access is governed by IAM alone.
#
#   SHELLS — Terraform creates the parameter with a placeholder and NEVER the
#   value. The EntraID client secret arrives out of band. Terraform must not
#   see it, and `ignore_changes` on `value` means a seeded secret is not
#   reverted to the placeholder on the next apply.
#
# The edge authenticator reads this whole prefix recursively at cold start, so
# adding a provider means adding shells here and one entry in its PROFILES map.

resource "random_password" "session_hmac_key" {
  length  = 64
  special = false
}

resource "aws_ssm_parameter" "session_hmac_key" {
  name        = "/${var.app_name}/${var.environment}/auth/session_hmac_key"
  description = "Signs __session cookies and x-auth-sig. Rotating it invalidates every live session."
  type        = "SecureString"
  value       = random_password.session_hmac_key.result

  tags = { Sensitivity = "secret" }
}

# --- EntraID (ADR-0010) ------------------------------------------------------

resource "aws_ssm_parameter" "entra_tenant_id" {
  name        = "/${var.app_name}/${var.environment}/auth/entra/tenant_id"
  description = "Only tokens whose `tid` claim equals this are admitted."
  type        = "String"
  value       = var.entra_tenant_id
}

resource "aws_ssm_parameter" "entra_client_id" {
  name        = "/${var.app_name}/${var.environment}/auth/entra/client_id"
  description = "Application (client) id of the EntraID app registration."
  type        = "String"
  value       = var.entra_client_id
}

resource "aws_ssm_parameter" "entra_client_secret" {
  name = "/${var.app_name}/${var.environment}/auth/entra/client_secret"
  description = join(" ", [
    "SHELL ONLY — seeded out of band, never by Terraform.",
    "The edge authenticator returns a 500 naming this parameter while it holds",
    "the placeholder, so a missing secret is loud rather than a silent 403.",
  ])
  type  = "SecureString"
  value = "UNSEEDED"

  lifecycle {
    # Without this, every apply after the secret is seeded would revert it to
    # "UNSEEDED" and take the environment down.
    ignore_changes = [value]
  }

  tags = { Sensitivity = "secret" }
}

# --- Admission ---------------------------------------------------------------
# The tenant check alone would admit every account in the tenant. Both checks
# are required (ADR-0010), which is why this list is not optional and an empty
# list admits nobody rather than everybody.

resource "aws_ssm_parameter" "allowed_users" {
  name        = "/${var.app_name}/${var.environment}/auth/allowed_users"
  description = "Comma-separated email allow-list. Empty admits NOBODY, deliberately."
  type        = "String"
  value       = join(",", var.allowed_users)
}

# --- Application configuration the edge and API both need --------------------

resource "aws_ssm_parameter" "fqdn" {
  name        = "/${var.app_name}/${var.environment}/app/fqdn"
  description = "Canonical hostname. Any other Host is rejected with 421."
  type        = "String"
  value       = var.fqdn
}

resource "aws_ssm_parameter" "session_ttl_seconds" {
  name        = "/${var.app_name}/${var.environment}/auth/session_ttl_seconds"
  description = "Lifetime of a human sign-in. Agent-minted sessions use their own, far shorter, TTL."
  type        = "String"
  value       = tostring(var.session_ttl_seconds)
}
