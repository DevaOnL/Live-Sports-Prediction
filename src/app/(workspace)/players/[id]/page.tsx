import { PlayerDetail } from "@/components/player-detail";

export default async function PlayerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: segment } = await params;
  // Client navigation can retain the escaped dynamic segment. Decode it before
  // PlayerDetail encodes the native identifier for its API request.
  let id = segment;
  try { id = decodeURIComponent(segment); } catch { /* The API rejects malformed identifiers. */ }
  return <PlayerDetail id={id} />;
}
