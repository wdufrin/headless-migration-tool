#
# Variables definition for Gemini Enterprise Test Environment
# Replicates testgebackupandrestorev2 architecture
#

variable "project_id" {
  description = "The GCP Project ID to create or configure for testing (must be globally unique, 6-30 chars, lowercase/digits/hyphens)."
  type        = string
}

variable "org_id" {
  description = "The GCP Organization ID where the project will be created."
  type        = string
  default     = "942977750288"
}

variable "billing_account_id" {
  description = "The Cloud Billing Account ID to link to the new project."
  type        = string
  default     = "0124EE-048763-814962"
}

variable "location" {
  description = "The Discovery Engine control plane location (global, us, or eu)."
  type        = string
  default     = "global"
}

variable "collection_id" {
  description = "The Discovery Engine collection ID."
  type        = string
  default     = "default_collection"
}

variable "engine_id" {
  description = "The Discovery Engine search engine / app ID (e.g. testnotebooks)."
  type        = string
  default     = "testnotebooks"
}

variable "engine_display_name" {
  description = "Display name for the Gemini Enterprise Intranet search engine."
  type        = string
  default     = "testnotebooks"
}

variable "dwd_sa_email" {
  description = "Service Account email used by the Gemini Enterprise Migration Tool for Domain-Wide Delegation."
  type        = string
  default     = "gemini-dwd-migrator@ancient-sandbox-322523.iam.gserviceaccount.com"
}

variable "admin_user_email" {
  description = "Email of the administrative user to grant roles/owner."
  type        = string
  default     = "admin@wdufrin.altostrat.com"
}

variable "editor_user_email" {
  description = "Email of the secondary user to grant roles/discoveryengine.editor."
  type        = string
  default     = "bryankelly@wdufrin.altostrat.com"
}

variable "workforce_pool_id" {
  description = "Workforce Identity Pool ID for Microsoft Entra ID / IdP federation."
  type        = string
  default     = "wdufrin-entra"
}

variable "entra_user_email" {
  description = "Specific external Entra ID user email to grant roles/discoveryengine.user."
  type        = string
  default     = "wdufrin@wdufrin.onmicrosoft.com"
}
