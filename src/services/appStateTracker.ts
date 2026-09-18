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

import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';

export interface OverriddenOrgPolicy {
  projectId: string;
  constraint: string;
  overriddenAt: string;
  overriddenValue?: any;
}

export interface CreatedServiceAccount {
  projectId: string;
  email: string;
  clientId?: string;
  roles?: string[];
  createdAt: string;
}

export interface AppliedIamBinding {
  projectId: string;
  email: string;
  role: string;
  appliedAt: string;
}

/**
 * A custom OIDC provider this tool registered inside a Workforce Identity Pool.
 *
 * This is the highest-consequence resource the tool creates: the tool holds the
 * signing key, so the provider can mint assertions for any subject without MFA.
 * It must be tracked so teardown can remove it and rollback verification can
 * prove it is gone.
 */
export interface CreatedWifProvider {
  workforcePoolId: string;
  providerId: string;
  location: string;
  issuerUri?: string;
  attributeCondition?: string;
  createdAt: string;
}

export interface MigrationAppState {
  overriddenOrgPolicies: OverriddenOrgPolicy[];
  createdServiceAccounts: CreatedServiceAccount[];
  appliedIamBindings: AppliedIamBinding[];
  createdWifProviders: CreatedWifProvider[];
}

export class AppStateTracker {
  private static stateFilePath = path.resolve(process.cwd(), '.migration-state.json');

  public static setStateFilePath(customPath: string): void {
    this.stateFilePath = customPath;
  }

  public static getStateFilePath(): string {
    return this.stateFilePath;
  }

  public static loadState(): MigrationAppState {
    try {
      if (fs.existsSync(this.stateFilePath)) {
        const raw = fs.readFileSync(this.stateFilePath, 'utf-8');
        const parsed = JSON.parse(raw);
        return {
          overriddenOrgPolicies: Array.isArray(parsed.overriddenOrgPolicies) ? parsed.overriddenOrgPolicies : [],
          createdServiceAccounts: Array.isArray(parsed.createdServiceAccounts) ? parsed.createdServiceAccounts : [],
          appliedIamBindings: Array.isArray(parsed.appliedIamBindings) ? parsed.appliedIamBindings : [],
          // Absent in state files written before provider tracking existed.
          createdWifProviders: Array.isArray(parsed.createdWifProviders) ? parsed.createdWifProviders : []
        };
      }
    } catch (err: any) {
      logger.warn(`Failed to read ${path.basename(this.stateFilePath)}: ${err.message}`);
    }

    // Auto-detect from sa-dwd-key.json if state file doesn't exist yet
    const autoAccounts: CreatedServiceAccount[] = [];
    try {
      const saKeyPath = path.resolve(process.cwd(), 'sa-dwd-key.json');
      if (fs.existsSync(saKeyPath)) {
        const saData = JSON.parse(fs.readFileSync(saKeyPath, 'utf-8'));
        if (saData.client_email && saData.project_id) {
          autoAccounts.push({
            projectId: saData.project_id,
            email: saData.client_email,
            clientId: saData.client_id,
            roles: ['roles/discoveryengine.admin', 'roles/serviceusage.serviceUsageConsumer'],
            createdAt: new Date().toISOString()
          });
        }
      }
    } catch (err: any) {
      // Previously swallowed. If sa-dwd-key.json is corrupt, auto-detection
      // silently yields no accounts and teardown then has nothing to clean up --
      // worth a line in the log rather than silence.
      logger.warn(`Could not auto-detect service account from sa-dwd-key.json: ${err.message}`);
    }

    return {
      overriddenOrgPolicies: [],
      createdServiceAccounts: autoAccounts,
      appliedIamBindings: [],
      createdWifProviders: []
    };
  }

  public static saveState(state: MigrationAppState): void {
    try {
      fs.writeFileSync(this.stateFilePath, JSON.stringify(state, null, 2), 'utf-8');
    } catch (err: any) {
      logger.error(`Failed to write ${path.basename(this.stateFilePath)}: ${err.message}`);
    }
  }

  public static recordOrgPolicyOverride(projectId: string, constraint: string, overriddenValue?: any): void {
    const state = this.loadState();
    const existingIdx = state.overriddenOrgPolicies.findIndex(
      p => p.projectId === projectId && p.constraint === constraint
    );
    const entry: OverriddenOrgPolicy = {
      projectId,
      constraint,
      overriddenAt: new Date().toISOString(),
      overriddenValue
    };
    if (existingIdx >= 0) {
      state.overriddenOrgPolicies[existingIdx] = entry;
    } else {
      state.overriddenOrgPolicies.push(entry);
    }
    this.saveState(state);
    logger.info(`Tracked organization policy override: ${constraint} on project ${projectId}`);
  }

  public static recordServiceAccount(projectId: string, email: string, clientId?: string, roles?: string[]): void {
    const state = this.loadState();
    const existingIdx = state.createdServiceAccounts.findIndex(
      s => s.projectId === projectId && s.email === email
    );
    const entry: CreatedServiceAccount = {
      projectId,
      email,
      clientId,
      roles: roles || ['roles/discoveryengine.admin', 'roles/serviceusage.serviceUsageConsumer'],
      createdAt: new Date().toISOString()
    };
    if (existingIdx >= 0) {
      state.createdServiceAccounts[existingIdx] = entry;
    } else {
      state.createdServiceAccounts.push(entry);
    }
    this.saveState(state);
    logger.info(`Tracked service account creation: ${email} on project ${projectId}`);
  }

  public static recordIamBinding(projectId: string, email: string, role: string): void {
    const state = this.loadState();
    const exists = state.appliedIamBindings.some(
      b => b.projectId === projectId && b.email === email && b.role === role
    );
    if (!exists) {
      state.appliedIamBindings.push({
        projectId,
        email,
        role,
        appliedAt: new Date().toISOString()
      });
      this.saveState(state);
      logger.info(`Tracked IAM role binding: ${role} to ${email} on project ${projectId}`);
    }
  }

  public static recordWifProvider(
    workforcePoolId: string,
    providerId: string,
    location: string,
    details?: { issuerUri?: string; attributeCondition?: string }
  ): void {
    const state = this.loadState();
    const existingIdx = state.createdWifProviders.findIndex(
      p =>
        p.workforcePoolId === workforcePoolId &&
        p.providerId === providerId &&
        p.location === location
    );
    const entry: CreatedWifProvider = {
      workforcePoolId,
      providerId,
      location,
      issuerUri: details?.issuerUri,
      attributeCondition: details?.attributeCondition,
      createdAt: new Date().toISOString()
    };
    if (existingIdx >= 0) {
      state.createdWifProviders[existingIdx] = entry;
    } else {
      state.createdWifProviders.push(entry);
    }
    this.saveState(state);
    logger.info(
      `Tracked Workforce Identity provider: ${providerId} in pool ${workforcePoolId} (${location})`
    );
  }

  public static clearTrackedState(): void {
    try {
      if (fs.existsSync(this.stateFilePath)) {
        fs.unlinkSync(this.stateFilePath);
      }
    } catch (err: any) {
      logger.warn(`Failed to delete ${path.basename(this.stateFilePath)}: ${err.message}`);
    }
  }
}
