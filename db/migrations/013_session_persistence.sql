-- Persistence is an issued server-side property, independent of optional cookies.
-- Existing sessions keep their current expiry and become nonrenewing.
ALTER TABLE auth.session ADD COLUMN persistent boolean NOT NULL DEFAULT false;
