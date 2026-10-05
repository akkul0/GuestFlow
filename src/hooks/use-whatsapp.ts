"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { onboardingApi } from "@/lib/api/endpoints";
import { qk } from "@/lib/query-keys";

export function useWhatsAppConnection() {
  return useQuery({ queryKey: qk.whatsapp, queryFn: () => onboardingApi.status(false) });
}

export function useWhatsAppActions() {
  const qc = useQueryClient();
  const set = (data: unknown) => qc.setQueryData(qk.whatsapp, data);
  return {
    connect: useMutation({ mutationFn: onboardingApi.connect, onSuccess: set }),
    disconnect: useMutation({ mutationFn: onboardingApi.disconnect, onSuccess: set }),
    refresh: useMutation({ mutationFn: () => onboardingApi.status(true), onSuccess: set }),
    migrateStart: useMutation({ mutationFn: onboardingApi.migrateStart, onSuccess: set }),
    migrateResend: useMutation({ mutationFn: onboardingApi.migrateResend, onSuccess: set }),
    migrateVerify: useMutation({ mutationFn: onboardingApi.migrateVerify, onSuccess: set }),
  };
}
