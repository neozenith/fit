output "function_name" { value = aws_lambda_function.api.function_name }
output "function_arn" { value = aws_lambda_function.api.arn }
output "role_arn" { value = aws_iam_role.api.arn }

output "function_url" {
  description = "Full https URL, including the trailing slash Lambda appends."
  value       = aws_lambda_function_url.api.function_url
}

output "function_url_domain" {
  description = "Host only — the form CloudFront's origin block needs."
  value       = replace(replace(aws_lambda_function_url.api.function_url, "https://", ""), "/", "")
}
