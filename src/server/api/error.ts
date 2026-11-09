const publicError = Symbol.for("live-sports.public-api-error");

/** Only explicit application errors may expose their message to an API client. */
export class PublicApiError extends Error {
  readonly [publicError] = true;

  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

/** Next.js route bundles can hold separate copies of the same class. */
export function isPublicApiError(error: unknown): error is PublicApiError {
  return error instanceof Error && (error as PublicApiError)[publicError] === true &&
    Number.isInteger((error as PublicApiError).status) &&
    (error as PublicApiError).status >= 400 && (error as PublicApiError).status < 500 &&
    /^[A-Za-z_]{1,64}$/.test((error as PublicApiError).code) && error.message.length <= 256;
}
