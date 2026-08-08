output "distribution_id" { value = aws_cloudfront_distribution.app.id }
output "distribution_arn" { value = aws_cloudfront_distribution.app.arn }
output "distribution_domain" { value = aws_cloudfront_distribution.app.domain_name }
output "spa_bucket" { value = aws_s3_bucket.spa.bucket }
output "certificate_arn" { value = aws_acm_certificate_validation.cert.certificate_arn }

output "url" {
  description = "The address a human types."
  value       = "https://${var.fqdn}"
}

output "auth_function_version" {
  description = "Changes on every config or code change, which is what forces a distribution update."
  value       = aws_lambda_function.auth.version
}
