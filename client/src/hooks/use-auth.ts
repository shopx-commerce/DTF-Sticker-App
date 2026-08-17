import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest, getQueryFn, ME_QUERY_KEY } from "@/lib/queryClient";

export interface AuthUser {
  id: number;
  email: string;
  name: string | null;
  role: string;
  emailVerified: boolean;
  createdAt: string;
}

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
