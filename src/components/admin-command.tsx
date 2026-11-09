"use client";

import Link from "next/link";
import { useRef, useState, type ReactNode } from "react";
import { api, ApiFailure } from "@/lib/api";

type CapturedCommand = { path: string; method: "POST" | "PATCH"; body: Record<string, unknown> };

/** A lost response must retry the captured body and UUID, never create new work. */
export function useAdminCommand<T>(onSuccess?: (result: T) => void) {
  const captured = useRef<CapturedCommand | null>(null);
  const busy = useRef(false);
  const [state, setState] = useState<{ pending: boolean; uncertain: boolean; error?: unknown; result?: T }>({ pending: false, uncertain: false });
  async function send(path: string, body: Record<string, unknown> = {}, method: "POST" | "PATCH" = "POST") {
    if (busy.current) return;
    const command = captured.current ?? { path, method, body: { ...body, requestId: crypto.randomUUID() } };
    captured.current = command;
    busy.current = true;
    setState({ pending: true, uncertain: false });
    try {
      const result = await api<T>(command.path, { method: command.method, body: command.body });
      captured.current = null;
      setState({ pending: false, uncertain: false, result });
      onSuccess?.(result);
    } catch (error) {
      const uncertain = !(error instanceof ApiFailure) || error.status >= 500;
      if (!uncertain) captured.current = null;
      setState({ pending: false, uncertain, error });
    } finally { busy.current = false; }
  }
  function clear() {
    if (!busy.current && !captured.current) setState({ pending: false, uncertain: false });
  }
  return { ...state, send, clear, locked: state.pending || state.uncertain };
}

export function CommandFeedback({ pending, uncertain, error, children }: {
  pending: boolean; uncertain: boolean; error?: unknown; children?: ReactNode;
}) {
  return <div className="command-feedback" role="status" aria-live="polite">
    {pending && <p>Submitting your request…</p>}
    {error !== undefined && <p className="error-message">{uncertain
      ? "The outcome could not be confirmed. Retry the same request below; its identifier and submitted values are retained to prevent duplicate work."
      : error instanceof Error ? error.message : "The request could not be completed."}</p>}
    {error instanceof ApiFailure && error.status === 401 && <Link className="text-link" href="/login">Sign in again</Link>}
    {error instanceof ApiFailure && error.status === 403 && <p>Administrator access is required. Your current account cannot perform this action.</p>}
    {children}
  </div>;
}
