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

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const LOG_LEVELS: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3
};

export class Logger {
  private level: LogLevel;
  private logBuffer: string[] = [];

  private listeners: ((level: LogLevel, line: string, message: string) => void)[] = [];

  constructor(level: LogLevel = 'INFO') {
    this.level = level;
  }

  setLevel(level: LogLevel) {
    this.level = level;
  }

  getLevel(): LogLevel {
    return this.level;
  }

  isDebugEnabled(): boolean {
    return LOG_LEVELS[this.level] <= LOG_LEVELS.DEBUG;
  }

  subscribe(listener: (level: LogLevel, line: string, message: string) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  private notify(level: LogLevel, line: string, message: string) {
    for (const listener of this.listeners) {
      try {
        listener(level, line, message);
      } catch {}
    }
  }

  private redact(message: string): string {
    // Redact Bearer tokens, passwords, and sensitive strings
    return message
      .replace(/Bearer\s+[a-zA-Z0-9_\-\.]+/gi, 'Bearer [REDACTED]')
      .replace(/client_secret=[^&\s]+/gi, 'client_secret=[REDACTED]')
      .replace(/"access_token":\s*"[^"]+"/gi, '"access_token": "[REDACTED]"');
  }

  private formatMessageWithMeta(message: string, meta?: any): string {
    const metaStr = meta ? ` | ${this.redact(JSON.stringify(meta))}` : '';
    return `${this.redact(message)}${metaStr}`;
  }

  private format(level: LogLevel, message: string, meta?: any): string {
    const timestamp = new Date().toISOString();
    return `[${timestamp}] [${level}] ${this.formatMessageWithMeta(message, meta)}`;
  }

  debug(message: string, meta?: any) {
    if (LOG_LEVELS[this.level] <= LOG_LEVELS.DEBUG) {
      const fullMsg = this.formatMessageWithMeta(message, meta);
      const line = this.format('DEBUG', message, meta);
      console.debug(line);
      this.logBuffer.push(line);
      this.notify('DEBUG', line, fullMsg);
    }
  }

  info(message: string, meta?: any) {
    if (LOG_LEVELS[this.level] <= LOG_LEVELS.INFO) {
      const fullMsg = this.formatMessageWithMeta(message, meta);
      const line = this.format('INFO', message, meta);
      console.info(line);
      this.logBuffer.push(line);
      this.notify('INFO', line, fullMsg);
    }
  }

  warn(message: string, meta?: any) {
    if (LOG_LEVELS[this.level] <= LOG_LEVELS.WARN) {
      const line = this.format('WARN', message, meta);
      console.warn(line);
      this.logBuffer.push(line);
      this.notify('WARN', line, message);
    }
  }

  error(message: string, meta?: any) {
    if (LOG_LEVELS[this.level] <= LOG_LEVELS.ERROR) {
      const line = this.format('ERROR', message, meta);
      console.error(line);
      this.logBuffer.push(line);
      this.notify('ERROR', line, message);
    }
  }

  getLogs(): string[] {
    return [...this.logBuffer];
  }

  clearLogs() {
    this.logBuffer = [];
  }
}

export const logger = new Logger();
