output "table_names" {
  description = "Logical table name -> physical DynamoDB table name."
  value       = { for k, t in aws_dynamodb_table.table : k => t.name }
}

output "table_arns" {
  description = "Logical table name -> ARN. Consumed by the API and archive IAM policies."
  value       = { for k, t in aws_dynamodb_table.table : k => t.arn }
}

output "archive_bucket" {
  description = "Bucket holding aged-out Parquet and Athena spill."
  value       = aws_s3_bucket.archive.bucket
}

output "archive_bucket_arn" {
  value = aws_s3_bucket.archive.arn
}

