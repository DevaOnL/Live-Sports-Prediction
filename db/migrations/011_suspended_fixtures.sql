-- A suspended fixture has a known nonfinal state; it is not an unknown result.
ALTER TABLE sports.fixtures DROP CONSTRAINT fixtures_status_check;
ALTER TABLE sports.fixtures ADD CONSTRAINT fixtures_status_check
  CHECK (status IN ('unknown', 'scheduled', 'live', 'final', 'postponed', 'cancelled', 'suspended'));
