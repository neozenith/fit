output "bucket" { value = module.finops.bucket }

output "prefix" {
  description = "What the API globs beneath. There is no catalogue to seed (ADR-0025)."
  value       = module.finops.prefix
}
