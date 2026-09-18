import { defineConfig } from 'vitest/config';

/**
 * Explicit vitest configuration.
 *
 * Previously there was no config file at all, which meant the suite ran on
 * vitest defaults. Two of those defaults caused real problems:
 *
 *  1. No setup file, so nothing stopped `GcpAuthService` from implicitly picking
 *     up live credentials (./sa-dwd-key.json, ./workforce-identity-config.json,
 *     ./wif-migration-key.pem) out of the repo root. Test runs performed real
 *     DWD mints and rewrote ./idp-subject-token.jwt in the working tree.
 *
 *  2. A 5000ms per-test timeout combined with fully parallel thread pools made
 *     tests/migrationRunner.test.ts flake: it passes in isolation and with
 *     --poolOptions.threads.singleThread, but intermittently times out when the
 *     machine is saturated. The timeout is raised rather than the concurrency
 *     removed so the suite stays fast, but see `hookTimeout` too.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['./tests/setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Surface async faults instead of letting them vanish into the reporter.
    dangerouslyIgnoreUnhandledErrors: false,
    clearMocks: true,
    restoreMocks: true,
  },
});
