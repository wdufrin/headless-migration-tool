#
# Outputs for Gemini Enterprise Test Environment
#

output "project_id" {
  description = "The created GCP project ID"
  value       = google_project.test_env.project_id
}

output "project_number" {
  description = "The created GCP project number"
  value       = google_project.test_env.number
}

output "engine_id" {
  description = "The Discovery Engine / Gemini Enterprise App ID"
  value       = var.engine_id
}

output "location" {
  description = "The Discovery Engine control plane location"
  value       = var.location
}

output "collection_id" {
  description = "The collection ID"
  value       = var.collection_id
}

output "assistant_id" {
  description = "Default Assistant ID"
  value       = "default_assistant"
}

output "migration_config_target" {
  description = "Target configuration block to paste into migration-config.json"
  value = {
    projectId    = google_project.test_env.project_id
    appLocation  = var.location
    collectionId = var.collection_id
    appId        = var.engine_id
    assistantId  = "default_assistant"
  }
}
