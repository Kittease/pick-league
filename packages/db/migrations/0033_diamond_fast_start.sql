-- Diamond target: when it last shrank. Until a first shrink (and again a week after the last one)
-- the worker grows the target every few kept cycles instead of once a day: on a platform with
-- spare budget (NA1 used 35 % of it with 5,000 Diamond players on 2026-11-23) a step a day takes
-- weeks to find what the budget carries.
ALTER TABLE diamond_tracking ADD COLUMN shrunk_at timestamptz;
