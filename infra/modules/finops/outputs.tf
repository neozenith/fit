output "bucket" { value = aws_s3_bucket.cur.bucket }
output "bucket_arn" { value = aws_s3_bucket.cur.arn }

output "prefix" {
  description = "Where the export lands. The API globs beneath it with DuckDB (ADR-0025)."
  value       = local.cur_data_path
}
