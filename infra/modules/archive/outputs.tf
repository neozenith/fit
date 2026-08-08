output "function_name" { value = aws_lambda_function.archive.function_name }
output "function_arn" { value = aws_lambda_function.archive.arn }

output "dry_run_command" {
  description = "Preview what the next run would move, without moving it."
  value       = "aws lambda invoke --function-name ${aws_lambda_function.archive.function_name} --payload '{\"dry_run\":true}' --cli-binary-format raw-in-base64-out /dev/stdout"
}
