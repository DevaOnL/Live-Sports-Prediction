-- Synthetic demonstration. Every change is rolled back; this script is rerunnable.
BEGIN;

-- INSERT: create a separate synthetic player without changing imported records.
INSERT INTO sports.players(provider,provider_id,name,position)
VALUES ('demo','sql-dml-example','Synthetic SQL DML player','UNKNOWN')
RETURNING id,provider,provider_id,name,position;

-- UPDATE: correct this demonstration player's position.
UPDATE sports.players SET name='Synthetic SQL DML forward',position='FWD'
WHERE provider='demo' AND provider_id='sql-dml-example'
RETURNING provider_id,name,position;

-- DELETE: remove exactly the row inserted above.
DELETE FROM sports.players WHERE provider='demo' AND provider_id='sql-dml-example'
RETURNING provider_id,name,position;

ROLLBACK;
