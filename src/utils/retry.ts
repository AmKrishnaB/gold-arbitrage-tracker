import { logger } from './logger.js';

export async function retry<T>(
  fn: () => Promise<T>,
  opts: { retries?: number; delayMs?: number; label?: string } = {},
): Promise<T> {
  const { retries = 3, delayMs = 1000, label = 'operation' } = opts;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isLast = attempt === retries;
      logger.warn(
        { attempt, retries, label, error: (err as Error).message },
        isLast ? `${label} failed after ${retries} attempts` : `${label} attempt ${attempt} failed, retrying...`,
      );
      if (isLast) throw err;
      await new Promise((r) => setTimeout(r, delayMs * attempt));
    }
  }

  throw new Error('unreachable');
}
