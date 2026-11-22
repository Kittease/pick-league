-- The worker can also track Diamond players (DIAMOND_MAX_TRACKED). Alone in its migration: a
-- value added to an enum cannot be used in the transaction that adds it.
ALTER TYPE ladder_tier ADD VALUE 'DIAMOND';
