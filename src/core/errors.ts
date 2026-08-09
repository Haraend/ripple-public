export class UserFacingError extends Error {
  readonly ephemeral: boolean;

  constructor(message: string, options: { ephemeral?: boolean; cause?: unknown } = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'UserFacingError';
    this.ephemeral = options.ephemeral ?? true;
  }
}
