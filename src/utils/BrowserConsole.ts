/**
 * A wrapper class for the browser's console object that allows enabling or disabling
 * logging and prefixes all log messages with a custom console name.
 *
 * @remarks
 * This class is useful for providing contextual logging in browser-based applications,
 * allowing logs to be toggled on or off and easily identified by a custom name.
 *
 * @example
 * ```typescript
 * const myConsole = new BrowserConsole(true, '[MyPlugin]');
 * myConsole.log('Hello, world!');
 * // Output: [MyPlugin] Hello, world!
 * ```
 */
import { diagnostics } from '../diagnostics/DiagnosticsLog';

export class BrowserConsole {
  private originalConsole: Console = console;
  enabled: boolean;
  consoleName: string;

  /**
   * Creates an instance of the class with the specified console state and name.
   *
   * @param enable - Determines whether the console is enabled.
   * @param consoleName - The name to assign to the console instance.
   */
  constructor(enable: boolean, consoleName: string) {
    this.enabled = enable;
    this.consoleName = consoleName;
  }

  /**
   * Logs messages to the browser console if logging is enabled.
   * Prepends the console name to the log output.
   *
   * @param {...any[]} args - The items to log to the console.
   */
  log(...args: unknown[]): void {
    this.forward('log', args);
  }

  /**
   * Logs informational messages to the console if logging is enabled.
   * Prepends the console name to the output.
   *
   * @param {...any[]} args - The messages or objects to log.
   */
  info(...args: unknown[]): void {
    this.forward('info', args);
  }

  /**
   * Logs a warning message to the console with the specified console name prefix,
   * if logging is enabled. Accepts any number of arguments to be logged.
   *
   * @param args - The items to log as a warning message.
   */
  warn(...args: unknown[]): void {
    this.forward('warn', args);
  }

  /**
   * Logs error messages to the console with the specified console name prefix,
   * if logging is enabled. Accepts any number of arguments to be logged.
   *
   * @param args - The error messages or objects to log.
   */
  error(...args: unknown[]): void {
    this.forward('error', args);
  }

  /**
   * Sends a line to the diagnostics log when it is on, and to the console when this one is.
   * @param level - Console level.
   * @param args - What was logged.
   */
  private forward(level: 'log' | 'info' | 'warn' | 'error', args: unknown[]): void {
    diagnostics.console(this.consoleName, level, args);
    if (!this.enabled) return;
    diagnostics.forwarding = true;
    try {
      this.originalConsole[level](this.consoleName, ...args);
    } finally {
      diagnostics.forwarding = false;
    }
  }
}
