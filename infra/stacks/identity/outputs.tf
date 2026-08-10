output "ssm_prefix" {
  description = "Prefix the edge authenticator reads recursively at cold start."
  value       = module.identity.ssm_prefix
}

output "client_secret_parameter_name" {
  description = "Seed this out of band before the environment can sign anyone in."
  value       = module.identity.client_secret_parameter_name
}

output "google_client_secret_parameter_name" {
  description = "Seed this out of band before the environment offers Google sign-in."
  value       = module.identity.google_client_secret_parameter_name
}

output "session_hmac_key_name" {
  description = "Read by `make token ENV=<env>` to mint an agent session (ADR-0011)."
  value       = module.identity.session_hmac_key_name
}
