import { describe, it, expect } from 'vitest';
import { validateEnvironmentConfig, getSafeDiscoveryEngineUrl, SecurityValidationError } from '../src/security/validator.js';
import { extractBearerToken, sanitizeHeadersForLogging } from '../src/security/headers.js';

describe('Security Layer & SSRF Protection (Mitigation #1)', () => {
  it('should accept valid GCP regions and alphanumeric project IDs', () => {
    expect(() => {
      validateEnvironmentConfig({
        projectId: 'fedex-test-project-123',
        appLocation: 'global',
        collectionId: 'default_collection',
        appId: 'test_engine_1',
        assistantId: 'default_assistant'
      });
    }).not.toThrow();

    expect(() => {
      validateEnvironmentConfig({
        projectId: 'prod-analytics-456',
        appLocation: 'us-central1',
        appId: 'chat_engine'
      });
    }).not.toThrow();
  });

  it('should reject invalid or malicious GCP regions (SSRF attack prevention)', () => {
    expect(() => {
      validateEnvironmentConfig({
        projectId: 'valid-project',
        appLocation: 'attacker.com/steal?q=',
        appId: 'engine1'
      });
    }).toThrow(SecurityValidationError);

    expect(() => {
      validateEnvironmentConfig({
        projectId: 'valid-project',
        appLocation: 'evil-region',
        appId: 'engine1'
      });
    }).toThrow(/Invalid or unapproved/);
  });

  it('should reject project IDs with invalid characters', () => {
    expect(() => {
      validateEnvironmentConfig({
        projectId: 'bad_project!@#',
        appLocation: 'global',
        appId: 'engine1'
      });
    }).toThrow(SecurityValidationError);
  });

  it('should construct correct and safe Discovery Engine base URLs', () => {
    expect(getSafeDiscoveryEngineUrl('global')).toBe('https://discoveryengine.googleapis.com');
    expect(getSafeDiscoveryEngineUrl('us-central1')).toBe('https://us-central1-discoveryengine.googleapis.com');
    expect(getSafeDiscoveryEngineUrl('EU')).toBe('https://eu-discoveryengine.googleapis.com');
  });
});

describe('Header Transport & Token Redaction (Mitigation #4)', () => {
  it('should extract Bearer tokens from authorization header', () => {
    expect(extractBearerToken('Bearer mock-test-token-value')).toBe('mock-test-token-value');
    expect(extractBearerToken('bearer mock-test-token-value')).toBe('mock-test-token-value');
    expect(extractBearerToken('Basic dXNlcjpwYXNz')).toBeNull();
    expect(extractBearerToken('')).toBeNull();
    expect(extractBearerToken(undefined)).toBeNull();
  });

  it('should redact sensitive tokens in headers before logging', () => {
    const headers = {
      'Authorization': 'Bearer mock-super-secret-token',
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': 'mock-secret-api-key',
      'User-Agent': 'Vitest-Agent'
    };

    const sanitized = sanitizeHeadersForLogging(headers);
    expect(sanitized['Authorization']).toBe('[REDACTED]');
    expect(sanitized['X-Goog-Api-Key']).toBe('[REDACTED]');
    expect(sanitized['Content-Type']).toBe('application/json');
  });
});
