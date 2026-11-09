"use client";

import { useEffect, useState } from "react";
import { api } from "./api";

export function useApi<T>(path: string | null, revision = 0) {
  const [state, setState] = useState<{ path: string | null; revision: number; data?: T; error?: unknown }>({ path: null, revision: -1 });
  useEffect(() => {
    if (path === null) return;
    const controller = new AbortController();
    api<T>(path, { signal: controller.signal }).then((data) => {
      if (!controller.signal.aborted) setState({ path, revision, data });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setState({ path, revision, error });
    });
    return () => controller.abort();
  }, [path, revision]);
  const current = state.path === path && state.revision === revision;
  return { data: current ? state.data : undefined, error: current ? state.error : undefined, loading: path !== null && (!current || (!state.data && !state.error)) };
}
