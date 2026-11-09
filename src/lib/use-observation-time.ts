"use client";

import { useEffect, useState } from "react";

/** Advance from the server snapshot using elapsed time, not the browser's wall clock. */
export function useObservationTime(referenceAt: string | undefined): string | undefined {
  const [clock, setClock] = useState<{ referenceAt: string; now: string }>();
  useEffect(() => {
    if (!referenceAt) return;
    const snapshot = Date.parse(referenceAt);
    if (!Number.isFinite(snapshot)) return;
    const started = performance.now();
    const timer = setInterval(() => setClock({ referenceAt, now: new Date(snapshot + performance.now() - started).toISOString() }), 30_000);
    return () => clearInterval(timer);
  }, [referenceAt]);
  return clock?.referenceAt === referenceAt ? clock?.now : referenceAt;
}
