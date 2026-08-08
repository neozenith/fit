output "bucket" { value = module.finops.bucket }
output "glue_database" { value = module.finops.glue_database }
output "athena_workgroup" { value = module.finops.athena_workgroup }

output "crawler_name" {
  description = "Run once by hand after the first export lands, rather than waiting for 03:00."
  value       = module.finops.crawler_name
}
