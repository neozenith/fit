output "url" { value = module.edge.url }
output "distribution_id" { value = module.edge.distribution_id }
output "distribution_domain" { value = module.edge.distribution_domain }

output "spa_bucket" {
  description = "Sync target for the built SPA in the frontend deploy workflow."
  value       = module.edge.spa_bucket
}
