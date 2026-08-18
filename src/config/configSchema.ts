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

import { z } from 'zod';
import { VALID_GCP_LOCATIONS } from '../security/validator.js';

export const EnvironmentConfigSchema = z.object({
  projectId: z.string().min(1).regex(/^[a-z0-9-]+$/i, 'Project ID must be alphanumeric with hyphens'),
  appLocation: z.string().refine(val => VALID_GCP_LOCATIONS.has(val.toLowerCase()), {
    message: 'appLocation must be a valid GCP Discovery Engine region'
  }),
  collectionId: z.string().regex(/^[a-z0-9-_]+$/i).default('default_collection'),
  appId: z.string().min(1).regex(/^[a-z0-9-_]+$/i),
  assistantId: z.string().regex(/^[a-z0-9-_]+$/i).default('default_assistant')
});

export const MigrationOptionsSchema = z.object({
  migrateNotebooks: z.boolean().default(true),
  migrateAgents: z.boolean().default(true),
  migrateSessions: z.boolean().default(true),
  exportArtifacts: z.boolean().default(true),
  agentTypes: z.array(z.enum(['LOW_CODE', 'WORKFLOW', 'ADK', 'A2A', 'OTHER', 'ALL'])).default(['ALL']),
  dryRun: z.boolean().default(false),
  concurrency: z.number().int().min(1).max(50).default(10),
  userFilter: z.array(z.string()).default([]),
  preserveOwnership: z.boolean().default(true),
  preserveSharing: z.boolean().default(true),
  publishAgents: z.boolean().default(false),
  prefixReplacements: z.record(z.string()).default({}),
  allowOverwrite: z.boolean().default(false),
  logLevel: z.enum(['DEBUG', 'INFO', 'WARN', 'ERROR']).default('INFO')
}).default({});

export const AuthConfigSchema = z.object({
  authType: z.enum(['SERVICE_ACCOUNT_KEY', 'WORKFORCE_IDENTITY_FEDERATION', 'APPLICATION_DEFAULT_CREDENTIALS']).default('SERVICE_ACCOUNT_KEY'),
  serviceAccountKeyPath: z.string().optional(),
  wifConfigPath: z.string().optional(),
  workforcePoolIssuer: z.string().optional()
}).default({});

export const DomainRuleSchema = z.object({
  fromDomain: z.string(),
  toDomain: z.string()
});

export const IdpMappingSchema = z.object({
  sourceIdp: z.enum(['MICROSOFT_ENTRA', 'OKTA', 'PING', 'GOOGLE_WORKSPACE', 'CUSTOM']).default('CUSTOM'),
  targetIdp: z.enum(['GOOGLE_CLOUD_IDENTITY', 'GOOGLE_WORKSPACE', 'CUSTOM']).default('GOOGLE_CLOUD_IDENTITY'),
  domainRules: z.array(DomainRuleSchema).default([]),
  fallbackUserEmail: z.string().optional()
}).default({});

export const MigrationConfigSchema = z.object({
  source: EnvironmentConfigSchema,
  target: EnvironmentConfigSchema,
  options: MigrationOptionsSchema,
  auth: AuthConfigSchema.optional(),
  idpMapping: IdpMappingSchema.optional(),
  datastoreMapping: z.record(z.string()).default({}),
  collectionMapping: z.record(z.string()).default({}),
  identityMapping: z.record(z.string()).default({}),
  defaultOwnerFallback: z.string().optional()
});

export type ValidatedMigrationConfig = z.infer<typeof MigrationConfigSchema>;
