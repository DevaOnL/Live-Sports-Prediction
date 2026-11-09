-- Better Auth core storage; authentication handlers are configured separately.
CREATE SCHEMA auth AUTHORIZATION lsp_migrator;

CREATE TABLE auth."user" (
    id text PRIMARY KEY CHECK (length(btrim(id)) > 0),
    name text NOT NULL CHECK (length(btrim(name)) > 0),
    email text NOT NULL CHECK (length(btrim(email)) > 3),
    "emailVerified" boolean NOT NULL DEFAULT false,
    image text,
    role text NOT NULL DEFAULT 'viewer' CHECK (role IN ('viewer', 'admin')),
    "createdAt" timestamptz NOT NULL DEFAULT now(),
    "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX user_email_normalized_unique ON auth."user" (lower(email));

CREATE TABLE auth.session (
    id text PRIMARY KEY CHECK (length(btrim(id)) > 0),
    "expiresAt" timestamptz NOT NULL,
    token text NOT NULL UNIQUE CHECK (length(btrim(token)) > 0),
    "createdAt" timestamptz NOT NULL DEFAULT now(),
    "updatedAt" timestamptz NOT NULL DEFAULT now(),
    "ipAddress" text,
    "userAgent" text,
    "userId" text NOT NULL REFERENCES auth."user" (id) ON DELETE CASCADE,
    CHECK ("expiresAt" > "createdAt")
);
CREATE INDEX session_user_expiry_idx ON auth.session ("userId", "expiresAt");

CREATE TABLE auth.account (
    id text PRIMARY KEY CHECK (length(btrim(id)) > 0),
    "accountId" text NOT NULL CHECK (length(btrim("accountId")) > 0),
    "providerId" text NOT NULL CHECK (length(btrim("providerId")) > 0),
    "userId" text NOT NULL REFERENCES auth."user" (id) ON DELETE CASCADE,
    "accessToken" text,
    "refreshToken" text,
    "idToken" text,
    "accessTokenExpiresAt" timestamptz,
    "refreshTokenExpiresAt" timestamptz,
    scope text,
    password text,
    "createdAt" timestamptz NOT NULL DEFAULT now(),
    "updatedAt" timestamptz NOT NULL DEFAULT now(),
    UNIQUE ("providerId", "accountId")
);
CREATE INDEX account_user_idx ON auth.account ("userId");

CREATE TABLE auth.verification (
    id text PRIMARY KEY CHECK (length(btrim(id)) > 0),
    identifier text NOT NULL CHECK (length(btrim(identifier)) > 0),
    value text NOT NULL CHECK (length(btrim(value)) > 0),
    "expiresAt" timestamptz NOT NULL,
    "createdAt" timestamptz NOT NULL DEFAULT now(),
    "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX verification_identifier_idx ON auth.verification (identifier);
