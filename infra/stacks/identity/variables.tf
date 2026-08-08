# EXACTLY ONE variable, and that is a decision rather than an accident
# (ADR-0008). `environment` selects which block of config.yml applies.
# Anything else that feels like a variable is configuration and belongs in
# config.yml, where it is reviewable in the diff rather than passed at the
# command line where it is not.

variable "environment" {
  description = "dev | test | prod."
  type        = string

  validation {
    condition     = contains(["dev", "test", "prod"], var.environment)
    error_message = "environment must be dev, test or prod."
  }
}
