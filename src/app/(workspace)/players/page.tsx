import { Suspense } from "react";
import { PlayerCatalogue } from "@/components/player-catalogue";
export default function PlayersPage() { return <Suspense fallback={<p role="status">Opening player catalogue…</p>}><PlayerCatalogue /></Suspense>; }
