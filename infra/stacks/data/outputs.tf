output "table_names" { value = module.data.table_names }
output "table_arns" { value = module.data.table_arns }
output "archive_bucket" { value = module.data.archive_bucket }
output "glue_database" { value = module.data.glue_database }
output "athena_workgroup" { value = module.data.athena_workgroup }

output "hot_window_months" {
  description = "Read by the archive stack to compute its cut-off."
  value       = local.env.hot_window_months
}
