import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest, getQueryFn, ME_QUERY_KEY, SESSION_EXPIRED_EVENT } from "@/lib/queryClient";
import { toast } from "@/hooks/use-toast";
import type { PublicUser } from "@shared/schema";

// Derived from PublicUser; createdAt overridden to string since it's JSON over the wire.
export type AuthUser = Omit<PublicUser, "createdAt"> & { createdAt: string };

interface MeResponse {
  user: AuthUser;
}

const ME_KEY = [ME_QUERY_KEY] as const;

// Unwraps apiRequest's `"401: {\"message\":...}"` error string back into a plain message.
export function getErrorMessage(error: unknown, fallback = "Something went wrong"): string {
  if (error instanceof Error) {
    const match = error.message.match(/^\d+:\s*([\s\S]*)$/);
    const body = match ? match[1] : error.message;
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed.message === "string") return parsed.message;
    } catch {
      // Not JSON — fall through to the raw text.
    }
    return body || fallback;
  }
  return fallback;
}

export function useAuth() {
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery<MeResponse | null>({
    queryKey: ME_KEY,
    queryFn: getQueryFn<MeResponse | null>({ on401: "returnNull" }),
  });

  const loginMutation = useMutation({
    mutationFn: async (input: { email: string; password: string }) => {
      const res = await apiRequest("POST", "/api/auth/login", input);
      return (await res.json()) as MeResponse;
    },
    onSuccess: (result) => {
      queryClient.setQueryData(ME_KEY, result);
    },
  });

  const registerMutation = useMutation({
    mutationFn: async (input: { email: string; password: string; name?: string }) => {
      const res = await apiRequest("POST", "/api/auth/register", input);
      return (await res.json()) as { message: string };
    },
  });

  const logoutMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/auth/logout");
    },
    onSuccess: () => {
      queryClient.setQueryData(ME_KEY, null);
    },
  });

  const forgotPasswordMutation = useMutation({
    mutationFn: async (input: { email: string }) => {
      const res = await apiRequest("POST", "/api/auth/forgot-password", input);
      return (await res.json()) as { message: string };
    },
  });

  const resetPasswordMutation = useMutation({
    mutationFn: async (input: { token: string; password: string }) => {
      const res = await apiRequest("POST", "/api/auth/reset-password", input);
      return (await res.json()) as { message: string };
    },
  });

  const resendVerificationMutation = useMutation({
    mutationFn: async (input: { email: string }) => {
      const res = await apiRequest("POST", "/api/auth/resend-verification", input);
      return (await res.json()) as { message: string };
    },
  });

  return {
    user: data?.user ?? null,
    isLoading,
    isAuthenticated: !!data?.user,

    login: loginMutation.mutateAsync,
    loginPending: loginMutation.isPending,

    register: registerMutation.mutateAsync,
    registerPending: registerMutation.isPending,

    logout: logoutMutation.mutateAsync,
    logoutPending: logoutMutation.isPending,

    forgotPassword: forgotPasswordMutation.mutateAsync,
    forgotPasswordPending: forgotPasswordMutation.isPending,

    resetPassword: resetPasswordMutation.mutateAsync,
    resetPasswordPending: resetPasswordMutation.isPending,

    resendVerification: resendVerificationMutation.mutateAsync,
    resendVerificationPending: resendVerificationMutation.isPending,
  };
}

// Owns the "session expired" toast; queryClient.ts just dispatches the event. Mount once near the app root.
export function useSessionExpiredToast() {
  useEffect(() => {
    let lastShown = 0;
    const handler = () => {
      const now = Date.now();
      if (now - lastShown < 5000) return; // debounce several 401s arriving at once
      lastShown = now;
      toast({ title: "Session expired", description: "Please log in again to continue.", variant: "destructive" });
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, handler);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, handler);
  }, []);
}
