import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest, getQueryFn } from "@/lib/queryClient";
import type { SerializedDesign } from "@shared/design-document";
import type { Design, DesignListItem } from "@shared/schema";

// Derived from Design; date columns overridden to string since they cross the wire as JSON.
export type DesignSummary = Omit<Design, "createdAt" | "updatedAt" | "deletedAt"> & {
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

// Derived from the lean list projection; updatedAt crosses the wire as JSON string.
export type DesignListSummary = Omit<DesignListItem, "updatedAt"> & { updatedAt: string };

const DESIGNS_KEY = ["/api/designs"] as const;

export function useDesignList() {
  return useQuery<{ designs: DesignListSummary[] } | null>({
    queryKey: DESIGNS_KEY,
    queryFn: getQueryFn<{ designs: DesignListSummary[] } | null>({ on401: "returnNull" }),
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
