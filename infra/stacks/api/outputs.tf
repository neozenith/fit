output "function_name" { value = module.api.function_name }
output "function_url" { value = module.api.function_url }

output "function_url_domain" {
  description = "Consumed by the edge stack as its API origin."
  value       = module.api.function_url_domain
}
