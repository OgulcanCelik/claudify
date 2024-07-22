export async function exponentialBackoff(
  fn: () => Promise<any>,
  maxRetries: number = 5,
  initialDelay: number = 1000
): Promise<any> {
  let retries = 0;
  while (true) {
    try {
      return await fn();
    } catch (error: any) {
      if (error.statusCode === 429 && retries < maxRetries) {
        const delay = error.headers["retry-after"]
          ? parseInt(error.headers["retry-after"]) * 1000
          : initialDelay * Math.pow(2, retries);
        console.log(`Rate limited. Retrying after ${delay}ms`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        retries++;
      } else {
        throw error;
      }
    }
  }
}

export function formatSpotifyError(error: any): string {
  return `Spotify API Error:
      Status: ${error.statusCode}
      Message: ${error.message}
      Reason: ${error.body?.error?.reason || "Unknown"}
      ${error.stack ? `Stack: ${error.stack}` : ""}`;
}
