output "ssm_prefix" {
  description = "The prefix the edge authenticator reads recursively at cold start."
  value       = "/${var.app_name}/${var.environment}"
}

output "session_hmac_key_arn" {
  description = "Granted to the edge role, and to the operator minting agent sessions (ADR-0011)."
  value       = aws_ssm_parameter.session_hmac_key.arn
}

output "session_hmac_key_name" {
  value = aws_ssm_parameter.session_hmac_key.name
}

output "client_secret_parameter_name" {
  description = "Seed this out of band. Named in the edge's 500 response while unseeded."
  value       = aws_ssm_parameter.entra_client_secret.name
}
