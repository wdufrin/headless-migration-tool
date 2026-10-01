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
import { readIndexHtml, extractFunctionSource } from './helpers/htmlFunctionExtractor.js';

const html = readIndexHtml();

describe('Targeted User Selection & Discovery — Delete All & Apostrophe Resilience', () => {
  describe('HTML markup verification', () => {
    it('contains the "Delete All" button in the discovery section header', () => {
      expect(html).toContain('id="btnClearAllTargetedUsers"');
      expect(html).toContain('onclick="clearAllTargetedUsers()"');
      expect(html).toMatch(/<button[^>]+id="btnClearAllTargetedUsers"[^>]*>[\s\S]*?Delete All[\s\S]*?<\/button>/);
    });

    it('contains the "Delete All" button in the CSV toolbar row next to Paste CSV / Users', () => {
      expect(html).toMatch(/<button[^>]+onclick="clearAllTargetedUsers\(\)"[^>]*>[\s\S]*?Delete All[\s\S]*?<\/button>/);
    });

    it('contains a quick clear/delete all button in the table header Action column', () => {
      expect(html).toMatch(/<th[^>]*>[\s\S]*?Action[\s\S]*?<button[^>]+onclick="clearAllTargetedUsers\(\)"[\s\S]*?<\/th>/);
    });

    it('does not contain vulnerable inline string literal interpolation for removeUserFromSelection in HTML template', () => {
      // The old vulnerable pattern was onclick="removeUserFromSelection('${escapeHtml(u.email)}')"
      expect(html).not.toContain("removeUserFromSelection('${escapeHtml(u.email)}')");
      // The secure pattern passes this.dataset.email
      expect(html).toContain('removeUserFromSelection(this.dataset.email)');
      expect(html).toContain('data-email="${escapeHtml(u.email)}"');
    });

    it('does not contain vulnerable inline string literal interpolation for toggleUserSelection in HTML template', () => {
      expect(html).not.toContain("toggleUserSelection('${escapeHtml(u.email)}')");
      expect(html).toContain('toggleUserSelection(this.dataset.email)');
    });
  });

  describe('Extracted function behaviors', () => {
    interface UserEntry {
      email: string;
      selected: boolean;
      sources?: string[];
    }

    interface SandboxScope {
      targetedUsersList: UserEntry[];
      explicitIdpOverrides: Record<string, string>;
      csvMappedKeysSet: Set<string>;
      logs: Array<{ message: string; level: string }>;
      confirmResult: boolean;
      confirmCalls: string[];
      tableRenderCalls: number;
      reportRenderCalls: number;
      customUserEmailInput: { value: string };
      bulkUserEmailsTextarea: { value: string };
      removeUserFromSelection: (emailOrEl: any) => void;
      toggleUserSelection: (emailOrEl: any) => void;
      updateTargetMappedIdentity: (sourceEmail: any, targetEmail: string) => void;
      clearAllTargetedUsers: () => void;
      renderUserSelectionTable: () => void;
      renderUserMappingReport: () => void;
    }

    function createSandbox(): SandboxScope {
      const logs: Array<{ message: string; level: string }> = [];
      const confirmCalls: string[] = [];
      let confirmResult = true;
      let tableRenderCalls = 0;
      let reportRenderCalls = 0;
      const customUserEmailInput = { value: 'temp@test.com' };
      const bulkUserEmailsTextarea = { value: 'user1@test.com\nuser2@test.com' };

      const documentStub = {
        getElementById: (id: string) => {
          if (id === 'customUserEmailInput') return customUserEmailInput;
          if (id === 'bulkUserEmailsTextarea') return bulkUserEmailsTextarea;
          return null;
        }
      };

      const removeSrc = extractFunctionSource(html, 'removeUserFromSelection');
      const toggleSrc = extractFunctionSource(html, 'toggleUserSelection');
      const updateSrc = extractFunctionSource(html, 'updateTargetMappedIdentity');
      const clearSrc = extractFunctionSource(html, 'clearAllTargetedUsers');

      const factory = new Function(
        'document',
        'addLog',
        'confirm',
        'onTableRender',
        'onReportRender',
        `
        let targetedUsersList = [];
        let explicitIdpOverrides = {};
        let csvMappedKeysSet = new Set();

        const renderUserSelectionTable = () => {
          onTableRender();
        };
        const renderUserMappingReport = () => {
          onReportRender();
        };

        ${removeSrc}
        ${toggleSrc}
        ${updateSrc}
        ${clearSrc}

        return {
          get targetedUsersList() { return targetedUsersList; },
          set targetedUsersList(val) { targetedUsersList = val; },
          get explicitIdpOverrides() { return explicitIdpOverrides; },
          set explicitIdpOverrides(val) { explicitIdpOverrides = val; },
          get csvMappedKeysSet() { return csvMappedKeysSet; },
          set csvMappedKeysSet(val) { csvMappedKeysSet = val; },
          removeUserFromSelection,
          toggleUserSelection,
          updateTargetMappedIdentity,
          clearAllTargetedUsers
        };
        `
      );

      const fns = factory(
        documentStub,
        (msg: string, lvl: string) => logs.push({ message: msg, level: lvl }),
        (msg: string) => {
          confirmCalls.push(msg);
          return confirmResult;
        },
        () => tableRenderCalls++,
        () => reportRenderCalls++
      );

      return {
        get targetedUsersList() { return fns.targetedUsersList; },
        set targetedUsersList(val: UserEntry[]) { fns.targetedUsersList = val; },
        get explicitIdpOverrides() { return fns.explicitIdpOverrides; },
        set explicitIdpOverrides(val: Record<string, string>) { fns.explicitIdpOverrides = val; },
        get csvMappedKeysSet() { return fns.csvMappedKeysSet; },
        set csvMappedKeysSet(val: Set<string>) { fns.csvMappedKeysSet = val; },
        logs,
        get confirmResult() { return confirmResult; },
        set confirmResult(val: boolean) { confirmResult = val; },
        confirmCalls,
        get tableRenderCalls() { return tableRenderCalls; },
        get reportRenderCalls() { return reportRenderCalls; },
        customUserEmailInput,
        bulkUserEmailsTextarea,
        removeUserFromSelection: fns.removeUserFromSelection,
        toggleUserSelection: fns.toggleUserSelection,
        updateTargetMappedIdentity: fns.updateTargetMappedIdentity,
        clearAllTargetedUsers: fns.clearAllTargetedUsers,
        renderUserSelectionTable: () => tableRenderCalls++,
        renderUserMappingReport: () => reportRenderCalls++
      };
    }

    it('clearAllTargetedUsers clears all users, explicit overrides, csv mapped keys, and resets input fields', () => {
      const sandbox = createSandbox();
      sandbox.targetedUsersList = [
        { email: "tim.o'connor@company.com", selected: true },
        { email: "d'angelo@company.com", selected: false },
        { email: "sarah.smith@company.com", selected: true }
      ];
      sandbox.explicitIdpOverrides["tim.o'connor@company.com"] = '849201@target.com';
      sandbox.explicitIdpOverrides["tim.o'connor@company.com".toLowerCase()] = '849201@target.com';
      sandbox.csvMappedKeysSet.add("tim.o'connor@company.com".toLowerCase());

      sandbox.clearAllTargetedUsers();

      expect(sandbox.confirmCalls).toHaveLength(1);
      expect(sandbox.targetedUsersList).toEqual([]);
      expect(sandbox.explicitIdpOverrides).toEqual({});
      expect(sandbox.csvMappedKeysSet.size).toBe(0);
      expect(sandbox.customUserEmailInput.value).toBe('');
      expect(sandbox.bulkUserEmailsTextarea.value).toBe('');
      expect(sandbox.tableRenderCalls).toBeGreaterThanOrEqual(1);
      expect(sandbox.reportRenderCalls).toBeGreaterThanOrEqual(1);
      expect(sandbox.logs.some(l => l.message.includes('Cleared all 3 targeted user(s)'))).toBe(true);
    });

    it('clearAllTargetedUsers aborts without clearing if operator cancels confirm dialog', () => {
      const sandbox = createSandbox();
      sandbox.confirmResult = false;
      sandbox.targetedUsersList = [
        { email: "tim.o'connor@company.com", selected: true }
      ];
      sandbox.explicitIdpOverrides["tim.o'connor@company.com"] = '849201@target.com';

      sandbox.clearAllTargetedUsers();

      expect(sandbox.confirmCalls).toHaveLength(1);
      expect(sandbox.targetedUsersList).toHaveLength(1);
      expect(sandbox.explicitIdpOverrides["tim.o'connor@company.com"]).toBe('849201@target.com');
      expect(sandbox.tableRenderCalls).toBe(0);
    });

    it('clearAllTargetedUsers handles empty list gracefully without showing confirm dialog', () => {
      const sandbox = createSandbox();
      sandbox.targetedUsersList = [];
      sandbox.explicitIdpOverrides = {};

      sandbox.clearAllTargetedUsers();

      expect(sandbox.confirmCalls).toHaveLength(0);
      expect(sandbox.logs.some(l => l.message.includes('already empty'))).toBe(true);
    });

    describe('removeUserFromSelection apostrophe and special character resilience', () => {
      it('successfully deletes a user whose email contains a single quote / apostrophe (string arg)', () => {
        const sandbox = createSandbox();
        const apostropheEmail = "tim.o'connor@company.com";
        sandbox.targetedUsersList = [
          { email: apostropheEmail, selected: true },
          { email: "d'angelo@example.com", selected: true },
          { email: "normal.user@company.com", selected: true }
        ];
        sandbox.explicitIdpOverrides[apostropheEmail] = '849201@target.com';
        sandbox.explicitIdpOverrides[apostropheEmail.toLowerCase()] = '849201@target.com';
        sandbox.csvMappedKeysSet.add(apostropheEmail.toLowerCase());

        sandbox.removeUserFromSelection(apostropheEmail);

        expect(sandbox.targetedUsersList.map(u => u.email)).toEqual([
          "d'angelo@example.com",
          "normal.user@company.com"
        ]);
        expect(sandbox.explicitIdpOverrides[apostropheEmail]).toBeUndefined();
        expect(sandbox.explicitIdpOverrides[apostropheEmail.toLowerCase()]).toBeUndefined();
        expect(sandbox.csvMappedKeysSet.has(apostropheEmail.toLowerCase())).toBe(false);
      });

      it('successfully deletes a user whose email contains an apostrophe when called with DOM element / dataset', () => {
        const sandbox = createSandbox();
        const apostropheEmail = "d'angelo@example.com";
        sandbox.targetedUsersList = [
          { email: "tim.o'connor@company.com", selected: true },
          { email: apostropheEmail, selected: true }
        ];

        // Simulating: removeUserFromSelection(this.dataset.email) where dataset has the exact email
        sandbox.removeUserFromSelection({ dataset: { email: apostropheEmail } });

        expect(sandbox.targetedUsersList.map(u => u.email)).toEqual([
          "tim.o'connor@company.com"
        ]);
      });

      it('safely rejects / ignores null, empty string, or non-matching emails without throwing', () => {
        const sandbox = createSandbox();
        sandbox.targetedUsersList = [
          { email: "tim.o'connor@company.com", selected: true }
        ];

        expect(() => sandbox.removeUserFromSelection(null)).not.toThrow();
        expect(() => sandbox.removeUserFromSelection('')).not.toThrow();
        expect(() => sandbox.removeUserFromSelection(undefined)).not.toThrow();
        expect(() => sandbox.removeUserFromSelection({ dataset: {} })).not.toThrow();
        expect(() => sandbox.removeUserFromSelection('nonexistent@company.com')).not.toThrow();

        expect(sandbox.targetedUsersList).toHaveLength(1);
      });

      it('demonstrates that evaluating the old unescaped string pattern throws a SyntaxError while data-email evaluates cleanly', () => {
        const emailWithApostrophe = "tim.o'connor@company.com";

        // HTML escaping of apostrophe produces &#039;
        const htmlEscaped = emailWithApostrophe.replace(/'/g, '&#039;');
        expect(htmlEscaped).toBe('tim.o&#039;connor@company.com');

        // When a browser parses an HTML attribute like onclick="removeUserFromSelection('${htmlEscaped}')",
        // the HTML entity &#039; is unescaped by the HTML parser into a literal ' BEFORE passing to the JS engine.
        // Therefore, the JS engine attempts to parse:
        const unescapedJsCodeInBrowser = `removeUserFromSelection('${emailWithApostrophe}')`;

        // In a real JavaScript parser, this throws a SyntaxError due to the unmatched quote!
        expect(() => {
          // eslint-disable-next-line no-new-func
          new Function('removeUserFromSelection', unescapedJsCodeInBrowser);
        }).toThrow(SyntaxError);

        // In contrast, with the fix, the attribute is onclick="removeUserFromSelection(this.dataset.email)"
        // and data-email="tim.o&#039;connor@company.com".
        // The JS handler is:
        const fixedJsCodeInBrowser = `removeUserFromSelection(this.dataset.email)`;
        let executedEmail = '';
        const mockThis = { dataset: { email: emailWithApostrophe } };

        expect(() => {
          // eslint-disable-next-line no-new-func
          const clickHandler = new Function('removeUserFromSelection', `
            const fn = function() { ${fixedJsCodeInBrowser}; };
            return fn.call(this);
          `);
          clickHandler.call(mockThis, (email: string) => {
            executedEmail = email;
          });
        }).not.toThrow();

        expect(executedEmail).toBe("tim.o'connor@company.com");
      });
    });

    describe('toggleUserSelection and updateTargetMappedIdentity apostrophe resilience', () => {
      it('toggles selection for users with apostrophes in email', () => {
        const sandbox = createSandbox();
        const apostropheEmail = "tim.o'connor@company.com";
        sandbox.targetedUsersList = [
          { email: apostropheEmail, selected: true }
        ];

        sandbox.toggleUserSelection(apostropheEmail);
        expect(sandbox.targetedUsersList[0].selected).toBe(false);

        sandbox.toggleUserSelection({ dataset: { email: apostropheEmail } });
        expect(sandbox.targetedUsersList[0].selected).toBe(true);
      });

      it('updates target mapped identity for users with apostrophes in email', () => {
        const sandbox = createSandbox();
        const apostropheEmail = "tim.o'connor@company.com";
        sandbox.targetedUsersList = [
          { email: apostropheEmail, selected: true }
        ];

        sandbox.updateTargetMappedIdentity(apostropheEmail, "tim.o'connor@target.com");
        expect(sandbox.explicitIdpOverrides[apostropheEmail]).toBe("tim.o'connor@target.com");

        sandbox.updateTargetMappedIdentity(
          { dataset: { email: apostropheEmail } },
          "custom.target@target.com"
        );
        expect(sandbox.explicitIdpOverrides[apostropheEmail]).toBe("custom.target@target.com");
      });
    });
  });
});
