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

import { GcpAuthService } from './gcpAuth.js';
import { logger } from '../utils/logger.js';

export interface UserAssetInventory {
  userEmail: string;
  agentNames: string[];
  notebookIds: string[];
  interactionCount: number;
}

export class BigQueryDiscoveryService {
  private auth: GcpAuthService;

  constructor(auth: GcpAuthService) {
    this.auth = auth;
  }

  /**
   * Queries BigQuery User_Backups telemetry dataset to discover active users and their referenced agents.
   */
  async discoverUsersFromBigQuery(projectId: string, datasetId: string = 'User_Backups'): Promise<UserAssetInventory[]> {
    const token = await this.auth.getAccessToken();
    const query = `
      SELECT
        COALESCE(jsonPayload.useriamprincipal, 'unknown') AS userEmail,
        ARRAY_AGG(DISTINCT jsonPayload.response.agentinfo.displayname IGNORE NULLS) AS agents,
        COUNT(1) AS totalEvents
      FROM \`${projectId}.${datasetId}.discoveryengine_googleapis_com_gemini_enterprise_user_activity_*\`
      WHERE _TABLE_SUFFIX >= FORMAT_DATE('%Y%m%d', DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY))
        AND jsonPayload.useriamprincipal IS NOT NULL
      GROUP BY 1
      ORDER BY totalEvents DESC
    `;

    try {
      const response = await fetch(`https://bigquery.googleapis.com/bigquery/v2/projects/${projectId}/queries`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          query,
          useLegacySql: false,
          timeoutMs: 30000
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        logger.warn(`BigQuery User Discovery query skipped/failed (${response.status}): ${errText}`);
        return [];
      }

      const data: any = await response.json();
      const rows = data.rows || [];
      return rows.map((r: any) => {
        const userEmail = r.f[0]?.v || '';
        const agents = (r.f[1]?.v || []).map((a: any) => a.v);
        const count = Number(r.f[2]?.v) || 0;
        return {
          userEmail,
          agentNames: agents,
          notebookIds: [],
          interactionCount: count
        };
      });
    } catch (err: any) {
      logger.warn(`Could not perform BigQuery telemetry lookup: ${err.message}`);
      return [];
    }
  }
}
