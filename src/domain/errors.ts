export class InvalidTransitionError extends Error {
  constructor(
    readonly entity: string,
    readonly from: string,
    readonly to: string,
  ) {
    super(`Invalid ${entity} transition: ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

export class CaptureExceedsAuthorizationError extends MoneyError {
  constructor(
    readonly requestedCents: number,
    readonly authorizedCents: number,
  ) {
    super(`Capture ${requestedCents} exceeds authorization ${authorizedCents}`);
    this.name = 'CaptureExceedsAuthorizationError';
  }
}
