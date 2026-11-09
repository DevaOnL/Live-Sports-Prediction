import type { ReadService } from "@/server/api/read";
import type { AdminService } from "@/server/api/admin";

export type OverviewData = Awaited<ReturnType<ReadService["overview"]>>;
export type CompetitionsData = Awaited<ReturnType<ReadService["competitions"]>>;
export type ClubsData = Awaited<ReturnType<ReadService["clubs"]>>;
export type PlayersData = Awaited<ReturnType<ReadService["players"]>>;
export type PlayerData = Awaited<ReturnType<ReadService["player"]>>;
export type ComparisonData = Awaited<ReturnType<ReadService["compare"]>>;
export type AdminStatusData = Awaited<ReturnType<AdminService["status"]>>;
export type JobsData = Awaited<ReturnType<AdminService["jobs"]>>;
export type AuditData = Awaited<ReturnType<AdminService["audit"]>>;
export type ImportsData = Awaited<ReturnType<AdminService["imports"]>>;
export type Identity = { id: string; name: string; email: string; role: "viewer" | "admin"; expiresAt: string };
