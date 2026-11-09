import { webConfigured } from "@/server/web/runtime";

export const dynamic = "force-dynamic";

export function GET() {
  const configured = webConfigured();
  return Response.json(
    {
      status: "ok",
      service: "web",
      scope: configured ? "application" : "process-only",
      checks: { process: "up" },
      features: { databaseIntegration: configured, ingestion: false, predictions: configured, authentication: configured },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
