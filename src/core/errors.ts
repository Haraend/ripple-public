export class UserFacingError extends Error {
  readonly ephemeral: boolean;

  constructor(message: string, options: { ephemeral?: boolean; cause?: unknown } = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'UserFacingError';
    this.ephemeral = options.ephemeral ?? true;
  }
}

/** Host concurrent-stream cap hit — queue must wait/retry, never skip-ahead. */
export class CapacityError extends UserFacingError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, { ephemeral: true, cause: options.cause });
    this.name = 'CapacityError';
  }
}
