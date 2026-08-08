variable "environment" {
  description = "dev | test | prod."
  type        = string

  validation {
    condition     = contains(["dev", "test", "prod"], var.environment)
    error_message = "environment must be dev, test or prod."
  }
}

variable "bundle_dir" {
  description = <<-EOT
    Directory holding the built API handler. Defaults to the build output the
    CI workflow produces; overridable so a plan can run against a prebuilt
    artefact rather than rebuilding.
  EOT
  type        = string
  default     = "../../../api/dist"
}
