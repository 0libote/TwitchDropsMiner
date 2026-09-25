/**
 * Dashboard HTTP client.
 *
 * Ports the CSRF bootstrap and single-retry write behaviour of the previous
 * vanilla client: the server rotates its token on logout/restart, so a stale
 * token comes back as 403 and is retried exactly once with a fresh token.
 */

let csrfTokenPromise: Promise<string> | null = null;

function resetCsrfToken(): void {
  csrfTokenPromise = null;
}

export function csrfToken(): Promise<string> {
  csrfTokenPromise ||= fetch("/api/csrf")
    .then((response) => {
      if (!response.ok) {
        throw new Error("Could not secure this request. Refresh and try again.");
      }
      return response.json() as Promise<{token: string}>;
    })
    .then((data) => data.token)
    .catch((error: unknown) => {
      csrfTokenPromise = null;
      throw error;
    });
  return csrfTokenPromise;
}

export async function request<T = unknown>(
  url: string,
  options: RequestInit = {},
  retried = false,
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string> | undefined),
  };
  const method = (options.method ?? "GET").toUpperCase();
  const isWrite = !["GET", "HEAD"].includes(method);
  if (isWrite) headers["X-CSRF-Token"] = await csrfToken();

  const response = await fetch(url, {...options, headers});
  if (!response.ok) {
    if (response.status === 403 && isWrite && !retried) {
      resetCsrfToken();
      return request<T>(url, options, true);
    }
    throw new Error(await response.text());
  }
  return (await response.json()) as T;
}

export {resetCsrfToken};
