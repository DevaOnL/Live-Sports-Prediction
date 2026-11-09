-- Shared atomic authentication throttles survive application process changes.
CREATE TABLE auth."rateLimit" (
  id text PRIMARY KEY CHECK (btrim(id) <> ''),
  key text NOT NULL UNIQUE CHECK (btrim(key) <> ''),
  count integer NOT NULL CHECK (count >= 0),
  "lastRequest" bigint NOT NULL CHECK ("lastRequest" >= 0)
);
CREATE INDEX rate_limit_last_request_idx ON auth."rateLimit" ("lastRequest");

REVOKE ALL ON auth."rateLimit" FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON auth."rateLimit" TO lsp_auth;
