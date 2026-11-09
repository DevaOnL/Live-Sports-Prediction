export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(
    {
      status: "ok",
      service: "web",
      scope: "process-only",
      checks: { process: "up" },
      features: { databaseIntegration: false, ingestion: false, predictions: false, authentication: false },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
