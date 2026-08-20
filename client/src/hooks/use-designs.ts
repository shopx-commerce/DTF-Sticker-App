import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest, getQueryFn } from "@/lib/queryClient";
import type { SerializedDesign } from "@shared/design-document";
import type { Design } from "@shared/schema";

// Derived from Design; date columns overridden to string since they cross the wire as JSON.
export type DesignSummary = Omit<Design, "createdAt" | "updatedAt" | "deletedAt"> & {
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

const DESIGNS_KEY = ["/api/designs"] as const;

export function useDesignList() {
  return useQuery<{ designs: DesignSummary[] } | null>({
    queryKey: DESIGNS_KEY,
    queryFn: getQueryFn<{ designs: DesignSummary[] } | null>({ on401: "returnNull" }),
  });
}

// Explicit queryFn, not getQueryFn — it only reads queryKey[0], which would fetch the list endpoint instead.
export function useDesign(id: number | null) {
  return useQuery<{ design: DesignSummary } | null>({
    queryKey: ["/api/designs", id],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/designs/${id}`);
      return res.json();
    },
    enabled: id !== null,
  });
}

export interface SaveDesignInput {
  name: string;
  state: SerializedDesign;
  sourceAssetId?: number;
  thumbnailAssetId?: number;
}

export function useDesignMutations() {
  const queryClient = useQueryClient();

  const invalidate = () => queryClient.invalidateQueries({ queryKey: DESIGNS_KEY });

  const create = useMutation({
    mutationFn: async (input: SaveDesignInput) => {
      const res = await apiRequest("POST", "/api/designs", input);
      return (await res.json()) as { design: DesignSummary };
    },
    onSuccess: invalidate,
  });

  const update = useMutation({
    mutationFn: async ({ id, ...input }: SaveDesignInput & { id: number }) => {
      const res = await apiRequest("PATCH", `/api/designs/${id}`, input);
      return (await res.json()) as { design: DesignSummary };
    },
    onSuccess: invalidate,
  });

  const duplicate = useMutation({
    mutationFn: async ({ id, name }: { id: number; name?: string }) => {
      const res = await apiRequest("POST", `/api/designs/${id}/duplicate`, name ? { name } : undefined);
      return (await res.json()) as { design: DesignSummary };
    },
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/designs/${id}`);
    },
    onSuccess: invalidate,
  });

  return { create, update, duplicate, remove };
}
