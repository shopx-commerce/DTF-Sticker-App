import { QueryClient, QueryFunction } from "@tanstack/react-query";

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

// Single source of truth for the /api/auth/me query key — use-auth.ts imports this
// rather than redeclaring it, so the cache key can't silently drift between the two files.
export const ME_QUERY_KEY = "/api/auth/me";

function isAuthEndpoint(url: string): boolean {
  return url.startsWith("/api/auth/");
}

// The toast itself lives in the useSessionExpiredToast hook, not here.
export const SESSION_EXPIRED_EVENT = "auth:session-expired";

// Skips auth endpoints (they have their own legitimate 401s) and no-ops unless the app currently believes it's logged in.
// On a real expiry: flips the cached user to null so every useAuth() consumer updates, without a hard navigation that would lose unsaved editor state.
function checkForSessionExpiry(url: string, status: number) {
  if (status !== 401 || isAuthEndpoint(url)) return;
  const wasLoggedIn = queryClient.getQueryData([ME_QUERY_KEY]);
  if (!wasLoggedIn) return;

  queryClient.setQueryData([ME_QUERY_KEY], null);
  window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
}

// Echoed back as a header on mutating requests — see server/lib/csrf.ts.
const CSRF_COOKIE = "csrf_token";
const CSRF_HEADER = "x-csrf-token";

function readCsrfCookie(): string | undefined {
  const match = document.cookie.match(new RegExp(`(?:^|; )${CSRF_COOKIE}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : undefined;
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const headers: Record<string, string> = data ? { "Content-Type": "application/json" } : {};
  if (method !== "GET") {
    const csrfToken = readCsrfCookie();
    if (csrfToken) headers[CSRF_HEADER] = csrfToken;
  }

  const res = await fetch(url, {
    method,
    headers,
    body: data ? JSON.stringify(data) : undefined,
    credentials: "include",
  });

  checkForSessionExpiry(url, res.status);
  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const url = queryKey[0] as string;
    const res = await fetch(url, {
      credentials: "include",
    });

    checkForSessionExpiry(url, res.status);

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
