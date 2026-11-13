-- champion-mastery-v4 returns champion ids beyond Data Dragon's list and the smallint range
-- (e.g. 60018 on KR), which made the whole mastery insert of those players fail.
ALTER TABLE champion_masteries ALTER COLUMN champion_id TYPE integer;
