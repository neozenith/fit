output "function_name" { value = module.archive.function_name }

output "dry_run_command" {
  description = "Preview what the next run would move, without moving it."
  value       = module.archive.dry_run_command
}
