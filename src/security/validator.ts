/**
 * Copyright 2026 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { EnvironmentConfig } from '../types/migration.js';

export const VALID_GCP_LOCATIONS = new Set<string>([
  'global',
  'us',
  'eu',
  'us-central1',
  'us-east1',
  'us-east4',
  'us-west1',
  'us-west2',
  'us-west3',
  'us-west4',
  'europe-west1',
  'europe-west2',
  'europe-west3',
  'europe-west4',
  'europe-west9',
  'asia-east1',
  'asia-northeast1',
  'asia-southeast1'
]);

const PROJECT_ID_REGEX = /^[a-z0-9-]+$/i;
const RESOURCE_ID_REGEX = /^[a-z0-9-_]+$/i;

export class SecurityValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecurityValidationError';
  }
}

/**
 * Validates environment parameters against strict SSRF and injection allowlists.
 * Enforces Mitigation #1 from the Admin Migration Report.
 */
export function validateEnvironmentConfig(env: EnvironmentConfig, role: 'source' | 'target' = 'source'): void {
  if (!env) {
    throw new SecurityValidationError(`Missing ${role} environment configuration.`);
  }

  if (!env.projectId || !PROJECT_ID_REGEX.test(env.projectId)) {
    throw new SecurityValidationError(
      `Invalid ${role} projectId: "${env.projectId}". Project IDs must only contain alphanumeric characters and hyphens.`
    );
  }

  if (!env.appLocation || !VALID_GCP_LOCATIONS.has(env.appLocation.toLowerCase())) {
    throw new SecurityValidationError(
      `Invalid or unapproved ${role} appLocation: "${env.appLocation}". Must be an authorized GCP Discovery Engine region.`
    );
  }

  if (env.collectionId && !RESOURCE_ID_REGEX.test(env.collectionId)) {
    throw new SecurityValidationError(
      `Invalid ${role} collectionId: "${env.collectionId}". Must only contain alphanumeric characters, hyphens, and underscores.`
    );
  }

  if (!env.appId || !RESOURCE_ID_REGEX.test(env.appId)) {
    throw new SecurityValidationError(
      `Invalid ${role} appId: "${env.appId}". Must only contain alphanumeric characters, hyphens, and underscores.`
    );
  }

  if (env.assistantId && !RESOURCE_ID_REGEX.test(env.assistantId)) {
    throw new SecurityValidationError(
      `Invalid ${role} assistantId: "${env.assistantId}". Must only contain alphanumeric characters, hyphens, and underscores.`
    );
  }
}

/**
 * Validates arbitrary resource identifiers (e.g. dataStoreId, notebookId, agentId).
 */
export function validateResourceId(id: string, resourceName: string = 'Resource ID'): string {
  if (!id || typeof id !== 'string' || !RESOURCE_ID_REGEX.test(id)) {
    throw new SecurityValidationError(
      `Invalid ${resourceName}: "${id}". Value must only contain alphanumeric characters, hyphens, and underscores.`
    );
  }
  return id;
}

/**
 * Construct safe Discovery Engine Base URL preventing SSRF.
 */
export function getSafeDiscoveryEngineUrl(location: string): string {
  const normalizedLoc = location.toLowerCase().trim();
  if (!VALID_GCP_LOCATIONS.has(normalizedLoc)) {
    throw new SecurityValidationError(`Refusing to construct URL with unvalidated location: "${location}"`);
  }

  return normalizedLoc === 'global'
    ? 'https://discoveryengine.googleapis.com'
    : `https://${normalizedLoc}-discoveryengine.googleapis.com`;
}
