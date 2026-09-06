import { useCallback, useEffect, useState } from "react";

export const AUTH_TOKEN_KEY = "ag_auth_token";
const UNAUTH_EVENT = "ag:unauthorized";

export function getAuthToken(): string | null {
  try {
    return localStorage.getItem(AUTH_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setAuthToken(token: string): void {
  try {
    localStorage.setItem(AUTH_TOKEN_KEY, token);
  } catch {}
}

export function clearAuthToken(): void {
  try {
    localStorage.removeItem(AUTH_TOKEN_KEY);
  } catch {}
}

/** Low-level fetch that injects Authorization header if token exists.
 *  On 401, clears token and dispatches global unauthorized event. */
export async function authFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const token = getAuthToken();
  const headers = new Headers(init.headers || {});
  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  // Always ensure JSON content-type if body is present and not already set? Don't override.
  const res = await fetch(input, { ...init, headers });
  if (res.status === 401) {
    // Only dispatch for protected-looking routes to avoid false positives on public 401
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : String(input);
    const isProtected =
      url.includes("/api/broker/") ||
      url.includes("/api/auth/session") ||
      url.includes("/api/auth/logout") ||
      url.includes("/api/broker");
    if (isProtected) {
      clearAuthToken();
      try {
        window.dispatchEvent(new CustomEvent(UNAUTH_EVENT));
      } catch {}
    }
  }
  return res;
}

export async function loginRequest(passcode: string): Promise<{ token: string; expiresAt: number }> {
  const res = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ passcode }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.success || !data?.token) {
    throw new Error(data?.message || "Login gagal — passcode salah.");
  }
  setAuthToken(data.token);
  return { token: data.token, expiresAt: data.expiresAt };
}

export async function logoutRequest(): Promise<void> {
  const token = getAuthToken();
  try {
    if (token) {
      await fetch("/api/auth/logout", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
    }
  } catch {}
  clearAuthToken();
  try {
    window.dispatchEvent(new CustomEvent(UNAUTH_EVENT));
  } catch {}
}

export function useAuth() {
  const [token, setToken] = useState<string | null>(() => getAuthToken());
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(() => !!getAuthToken());
  const [isChecking, setIsChecking] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const checkSession = useCallback(async () => {
    const t = getAuthToken();
    if (!t) {
      setIsAuthenticated(false);
      setToken(null);
      setIsChecking(false);
      return false;
    }
    try {
      const res = await fetch("/api/auth/session", {
        headers: { Authorization: `Bearer ${t}` },
      });
      if (res.ok) {
        const data = await res.json().catch(() => null);
        if (data?.success && data?.authenticated) {
          setIsAuthenticated(true);
          setToken(t);
          setIsChecking(false);
          return true;
        }
      }
      // invalid / expired
      clearAuthToken();
      setIsAuthenticated(false);
      setToken(null);
      setIsChecking(false);
      return false;
    } catch {
      // Network error: keep authenticated optimistically if token exists, but mark checking done
      setIsAuthenticated(!!getAuthToken());
      setIsChecking(false);
      return !!getAuthToken();
    }
  }, []);

  useEffect(() => {
    checkSession();
    const onUnauth = () => {
      setIsAuthenticated(false);
      setToken(null);
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === AUTH_TOKEN_KEY) {
        const nt = getAuthToken();
        setToken(nt);
        setIsAuthenticated(!!nt);
        if (nt) checkSession();
      }
    };
    window.addEventListener(UNAUTH_EVENT as any, onUnauth);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(UNAUTH_EVENT as any, onUnauth);
      window.removeEventListener("storage", onStorage);
    };
  }, [checkSession]);

  const login = useCallback(async (passcode: string) => {
    setError(null);
    try {
      const { token: newToken } = await loginRequest(passcode);
      setToken(newToken);
      setIsAuthenticated(true);
      // verify session after login to sync
      await checkSession();
      return true;
    } catch (err: any) {
      setError(err?.message || "Login gagal");
      throw err;
    }
  }, [checkSession]);

  const logout = useCallback(async () => {
    await logoutRequest();
    setToken(null);
    setIsAuthenticated(false);
  }, []);

  return {
    token,
    isAuthenticated,
    isChecking,
    error,
    login,
    logout,
    checkSession,
    getAuthToken,
    authFetch,
  };
}
