export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export const Result = {
  ok: <T>(value: T): Result<T> => ({ ok: true, value }),
  err: (error: string): Result<never> => ({ ok: false, error })
} as const;
