output "bucket" { value = aws_s3_bucket.cur.bucket }
output "bucket_arn" { value = aws_s3_bucket.cur.arn }
output "glue_database" { value = aws_glue_catalog_database.finops.name }
output "athena_workgroup" { value = aws_athena_workgroup.finops.name }

output "crawler_name" {
  description = "Run it manually after the first export lands rather than waiting for 03:00."
  value       = aws_glue_crawler.cur.name
}
