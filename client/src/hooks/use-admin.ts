import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest, getQueryFn } from "@/lib/queryClient";
import type { SerializedDesign } from "@shared/design-document";
import type { UserWithStats, DesignWithOwner, AdminStats, Design } from "@shared/schema";

// Derived from the shared aggregate types; date columns cross the wire as JSON strings.
export type AdminUserRow = Omit<UserWithStats, "createdAt"> & { createdAt: string };
export type AdminDesignRow = Omit<DesignWithOwner, "createdAt" | "updatedAt"> & { createdAt: string; updatedAt: string };
export type { AdminStats };

export function useAdminStats() {
  return useQuery<{ stats: AdminStats } | null>({
    queryKey: ["/api/admin/stats"],
    queryFn: getQueryFn<{ stats: AdminStats } | null>({ on401: "returnNull" }),
  });
}

export function useAdminUsers() {
  return useQuery<{ users: AdminUserRow[] } | null>({
    queryKey: ["/api/admin/users"],
    queryFn: getQueryFn<{ users: AdminUserRow[] } | null>({ on401: "returnNull" }),
  });
}

export function useAdminDesigns() {
  return useQuery<{ designs: AdminDesignRow[] } | null>({
    queryKey: ["/api/admin/designs"],
    queryFn: getQueryFn<{ designs: AdminDesignRow[] } | null>({ on401: "returnNull" }),
  });
}

// Matches getDesignWithOwner's Design & { ownerEmail } shape, minus deletedAt (always null here).
export type AdminDesignDetail = Omit<Design, "createdAt" | "updatedAt" | "deletedAt"> & {
  createdAt: string;
  updatedAt: string;
  ownerEmail: string;
};

// Explicit queryFn, not getQueryFn — it only reads queryKey[0], which would fetch the list endpoint instead.
export function useAdminDesignDetail(id: number | null) {
  return useQuery<{ design: AdminDesignDetail } | null>({
    queryKey: ["/api/admin/designs", id],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/admin/designs/${id}`);
      return res.json();
    },
    enabled: id !== null,
  });
}

export function useForkDesign() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, name }: { id: number; name?: string }) => {
      const res = await apiRequest("POST", `/api/admin/designs/${id}/fork`, name ? { name } : undefined);
      return (await res.json()) as { design: { id: number; name: string; state: SerializedDesign }; reused?: boolean };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/designs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });
      queryClient.invalidateQueries({ queryKey: ["/api/designs"] });
    },
  });
}
