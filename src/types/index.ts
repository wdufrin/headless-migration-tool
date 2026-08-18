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

export interface IamBinding {
  role: string;
  members: string[];
  condition?: {
    title: string;
    description?: string;
    expression: string;
  };
}

export interface IamPolicy {
  version?: number;
  bindings?: IamBinding[];
  etag?: string;
}

export interface StarterPrompt {
  text: string;
}

export interface DataStoreConnection {
  dataStore?: string;
  documentProcessingMode?: string;
}

export interface AuthorizationConfig {
  toolAuthorizations?: string[];
  [key: string]: any;
}

export interface Agent {
  name: string;
  displayName: string;
  description?: string;
  icon?: string;
  category?: string;
  starterPrompts?: StarterPrompt[];
  dataStoreConnections?: DataStoreConnection[];
  authorizationConfig?: AuthorizationConfig;
  authorizations?: string[];
  adkAgentDefinition?: Record<string, any>;
  a2aAgentDefinition?: Record<string, any>;
  lowCodeAgentDefinition?: Record<string, any>;
  targetId?: string;
  iamPolicy?: IamPolicy;
  owner?: string;
  [key: string]: any;
}

export interface NotebookSource {
  name?: string;
  title?: string;
  displayName?: string;
  url?: string;
  text?: string;
  content?: string;
  tailwindDoc?: any;
  webScrapeConfig?: {
    url: string;
    [key: string]: any;
  };
  metadata?: {
    owner?: string;
    creator?: string;
    ownerEmail?: string;
    creatorEmail?: string;
    googleDocsMetadata?: {
      documentId: string;
      mimeType?: string;
    };
    google_docs_metadata?: {
      documentId: string;
      mimeType?: string;
    };
    youtubeMetadata?: {
      youtubeUrl?: string;
      videoId?: string;
      uri?: string;
      url?: string;
    };
    youtube_metadata?: {
      youtubeUrl?: string;
      videoId?: string;
      uri?: string;
      url?: string;
    };
    webpageMetadata?: {
      webpageUrl: string;
    };
    webpage_metadata?: {
      webpageUrl: string;
    };
    agentspaceMetadata?: {
      documentName: string;
    };
    agentspace_metadata?: {
      documentName: string;
    };
    [key: string]: any;
  };
  [key: string]: any;
}

export interface NotebookNote {
  name?: string;
  title?: string;
  content?: string;
  type?: string;
  createTime?: string;
  updateTime?: string;
  [key: string]: any;
}

export interface Notebook {
  name: string;
  title: string;
  displayName?: string;
  owner?: string;
  creator?: string;
  createTime?: string;
  updateTime?: string;
  metadata?: {
    owner?: string;
    creator?: string;
    ownerEmail?: string;
    creatorEmail?: string;
    userRole?: string;
    isShared?: boolean;
    [key: string]: any;
  };
  sources?: NotebookSource[];
  notes?: NotebookNote[];
  artifacts?: any[];
  [key: string]: any;
}

export interface DataStore {
  name: string;
  displayName: string;
  industryVertical?: string;
  solutionTypes?: string[];
  contentConfig?: string;
  [key: string]: any;
}

export interface AppEngine {
  name: string;
  displayName: string;
  solutionType?: string;
  dataStoreIds?: string[];
  chatEngineConfig?: any;
  searchEngineConfig?: any;
  [key: string]: any;
}
