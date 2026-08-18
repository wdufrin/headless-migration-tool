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

import { describe, it, expect } from 'vitest';
import { IdentityMappingService } from '../src/services/identityMappingService.js';

describe('IdentityMappingService', () => {
  it('should auto-map identities matching domain rules', () => {
    const service = new IdentityMappingService({
      domainRules: [
        { fromDomain: '@legacy.onmicrosoft.com', toDomain: '@company.com' },
        { fromDomain: '@okta.partner.com', toDomain: '@company.com' }
      ]
    });

    const res1 = service.resolveIdentity('john.doe@legacy.onmicrosoft.com');
    expect(res1.targetIdentity).toBe('john.doe@company.com');
    expect(res1.status).toBe('AUTO_MAPPED');

    const res2 = service.resolveIdentity('user:jane.smith@okta.partner.com');
    expect(res2.targetIdentity).toBe('jane.smith@company.com');
    expect(res2.status).toBe('AUTO_MAPPED');
  });

  it('should prioritize explicit mappings over domain rules', () => {
    const service = new IdentityMappingService({
      domainRules: [
        { fromDomain: '@legacy.onmicrosoft.com', toDomain: '@company.com' }
      ],
      explicitMappings: {
        'john.doe@legacy.onmicrosoft.com': 'custom.jdoe@company.com'
      }
    });

    const res = service.resolveIdentity('john.doe@legacy.onmicrosoft.com');
    expect(res.targetIdentity).toBe('custom.jdoe@company.com');
    expect(res.status).toBe('MANUAL_OVERRIDE');
    expect(res.isCustomOverride).toBe(true);
  });

  it('should apply fallback email when no rules match and fallback is set', () => {
    const service = new IdentityMappingService({
      domainRules: [
        { fromDomain: '@legacy.onmicrosoft.com', toDomain: '@company.com' }
      ],
      defaultFallbackEmail: 'admin@company.com'
    });

    const res = service.resolveIdentity('external.contractor@thirdparty.com');
    expect(res.targetIdentity).toBe('admin@company.com');
    expect(res.status).toBe('FALLBACK_APPLIED');
  });

  it('should bulk auto-map a list of discovered users', () => {
    const service = new IdentityMappingService({
      domainRules: [
        { fromDomain: '@legacy.onmicrosoft.com', toDomain: '@company.com' }
      ]
    });

    const users = [
      'alice@legacy.onmicrosoft.com',
      'bob@legacy.onmicrosoft.com',
      'charlie@otherdomain.com'
    ];

    const results = service.autoMapUserList(users);
    expect(results).toHaveLength(3);
    expect(results[0].targetIdentity).toBe('alice@company.com');
    expect(results[1].targetIdentity).toBe('bob@company.com');
    expect(results[2].targetIdentity).toBe('charlie@otherdomain.com');
  });

  it('should provide standard enterprise IdP transition presets', () => {
    const presets = IdentityMappingService.getIdpPresets();
    expect(presets).toHaveProperty('ENTRA_TO_GOOGLE');
    expect(presets).toHaveProperty('OKTA_TO_GOOGLE');
    expect(presets).toHaveProperty('PING_TO_GOOGLE');
    expect(presets.ENTRA_TO_GOOGLE.domainRules.length).toBeGreaterThan(0);
  });
});
