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
import { execFileSync } from 'child_process';
import { readIndexHtml, extractFunctionSource } from './helpers/htmlFunctionExtractor.js';

/**
 * The WiF setup script shown in the wizard is meant to be copy-pasted into an
 * interactive shell. It previously emitted the CEL attribute condition wrapped in
 * DOUBLE quotes:
 *
 *   --attribute-condition="assertion.email != '' && !assertion.sub.startsWith('service-')"
 *
 * bash performs history expansion on `!` even inside double quotes, so pasting
 * that produced:
 *
 *   bash: !assertion.sub.startsWith: event not found
 *
 * These tests pin the POSIX single-quoting that fixes it, and verify the escaping
 * against a real bash process rather than by eyeballing the string.
 */

const html = readIndexHtml();

function loadShellSingleQuote(): (value: string) => string {
  const source = extractFunctionSource(html, 'shellSingleQuote');
  // eslint-disable-next-line no-new-func
  return new Function(`${source}; return shellSingleQuote;`)();
}

const shellSingleQuote = loadShellSingleQuote();

/**
 * Feeds the quoted value to a real bash and returns what bash actually passed to
 * the program. If the quoting is wrong, this either throws or returns the wrong
 * string -- it cannot silently pass.
 */
function roundTripThroughBash(value: string): string {
  const quoted = shellSingleQuote(value);
  return execFileSync('bash', ['-c', `printf '%s' ${quoted}`], { encoding: 'utf8' });
}

describe('shellSingleQuote', () => {
  it('wraps a plain value in single quotes', () => {
    expect(shellSingleQuote('hello')).toBe("'hello'");
  });

  it('escapes an embedded single quote using the close/literal/reopen idiom', () => {
    expect(shellSingleQuote("it's")).toBe("'it'\\''s'");
  });

  it.each([
    ['plain text', 'hello world'],
    ['the default CEL', 'assertion.email != "" && !assertion.sub.startsWith("service-")'],
    ['legacy CEL using single-quoted literals', "assertion.email != '' && !assertion.sub.startsWith('service-')"],
    ['bare exclamation marks', '!!! !a !b'],
    ['double quotes', 'say "hi"'],
    ['backslashes', 'a\\b\\\\c'],
    ['a newline', 'line1\nline2'],
    ['dollar and backtick', '$HOME `whoami` ${PATH}'],
    ['only a single quote', "'"],
    ['empty string', '']
  ])('round-trips %s through a real bash unchanged', (_label, value) => {
    expect(roundTripThroughBash(value)).toBe(value);
  });

  // ---- Adversarial: quoting must neutralise injection, not merely look tidy. ----

  it('neutralises command substitution instead of executing it', () => {
    const payload = '$(touch /tmp/should-never-exist-shellquote-test)';
    expect(roundTripThroughBash(payload)).toBe(payload);
    expect(() => execFileSync('test', ['-e', '/tmp/should-never-exist-shellquote-test'])).toThrow();
  });

  it('neutralises a quote-break-out attempt', () => {
    const payload = "'; echo PWNED; '";
    const output = roundTripThroughBash(payload);
    expect(output).toBe(payload);
    expect(output).not.toContain('PWNED\n');
  });
});

describe('Generated WiF gcloud script is safe to paste into a shell', () => {
  const updateWifScript = extractFunctionSource(html, 'updateWifScript');

  it('builds the attribute-condition argument with shellSingleQuote', () => {
    expect(updateWifScript).toContain('--attribute-condition=${shellSingleQuote(attrCond)}');
  });

  it('no longer wraps the attribute condition in double quotes', () => {
    // This is the exact construction that caused "event not found".
    expect(updateWifScript).not.toContain('--attribute-condition="${attrCond}"');
  });

  it('the shipped default CEL survives an interactive-shell paste', () => {
    // Pull the default straight out of the page so the test tracks the real value.
    const match = /wizWifAttributeCondition'\)\?\.value\?\.trim\(\) \|\| '([^']+)'/.exec(updateWifScript);
    expect(match, 'could not locate the default CEL in updateWifScript').not.toBeNull();

    const defaultCel = match![1];
    expect(defaultCel).toContain('!assertion.sub.startsWith');
    expect(roundTripThroughBash(defaultCel)).toBe(defaultCel);
  });

  it('history expansion does not fire on the generated argument in an interactive bash', () => {
    const defaultCel = 'assertion.email != "" && !assertion.sub.startsWith("service-")';
    const line = `echo --attribute-condition=${shellSingleQuote(defaultCel)}\n`;

    // `bash -c` skips history expansion entirely, so it cannot reproduce the bug.
    // Piping to `bash -i` goes through the same input path a human paste does.
    const output = execFileSync('bash', ['-i'], {
      input: line,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });

    expect(output).toContain(`--attribute-condition=${defaultCel}`);
    expect(output).not.toContain('event not found');
  });
});
