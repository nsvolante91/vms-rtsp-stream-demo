/**
 * Structured logger with level-based filtering.
 *
 * Provides prefixed log output with configurable severity levels
 * for consistent, filterable console output across the application.
 */

/** Log severity levels in ascending order */
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

/**
 * Simple structured logger with prefix tagging and level-based filtering.
 *
 * Each logger instance has a prefix string (typically a module/component name)
 * that is prepended to all output, making it easy to trace log sources.
 */
export class Logger {
  /**
   * Create a new Logger instance.
   * @param prefix - Tag prepended to all log messages (e.g., "WSReceiver", "Decoder")
   * @param level - Minimum severity level to output; messages below this are suppressed
   */
  constructor(
    private readonly prefix: string,
    private level: LogLevel = LogLevel.INFO
  ) {}

  /**
   * Set the minimum log level.
   * @param level - New minimum severity level
   */
  setLevel(level: LogLevel): void {
    this.level = level;
  }

  /**
   * Log a debug-level message. Only output when level is DEBUG.
   * @param msg - Log message
   * @param args - Additional values to log
   */
  debug(msg: string, ...args: unknown[]): void {
    if (this.level <= LogLevel.DEBUG) {
      console.debug(`[${this.prefix}] ${msg}`, ...args);
    }
  }

  /**
   * Log an info-level message.
   * @param msg - Log message
   * @param args - Additional values to log
   */
  info(msg: string, ...args: unknown[]): void {
    if (this.level <= LogLevel.INFO) {
      console.info(`[${this.prefix}] ${msg}`, ...args);
    }
  }

  /**
   * Log a warning-level message.
   * @param msg - Log message
   * @param args - Additional values to log
   */
  warn(msg: string, ...args: unknown[]): void {
    if (this.level <= LogLevel.WARN) {
      console.warn(`[${this.prefix}] ${msg}`, ...args);
    }
  }

  /**
   * Log an error-level message.
   * @param msg - Log message
   * @param args - Additional values to log
   */
  error(msg: string, ...args: unknown[]): void {
    if (this.level <= LogLevel.ERROR) {
      console.error(`[${this.prefix}] ${msg}`, ...args);
    }
  }
}
