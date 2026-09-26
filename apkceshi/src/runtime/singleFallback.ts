export async function runWithSingleFallback<T>(
  operation: () => Promise<T>,
  activateFallback: () => Promise<void>,
  shouldFallback: (error: unknown) => boolean,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!shouldFallback(error)) throw error;
    await activateFallback();
    return operation();
  }
}
