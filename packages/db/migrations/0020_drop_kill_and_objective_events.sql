-- kill_events and objective_events were stored for every match (~17 KB per match, 7 GB for
-- 430k matches) and never read: no view, endpoint or screen uses them. The worker no longer
-- parses these timeline events.

DROP TABLE kill_events;
DROP TABLE objective_events;
DROP TYPE objective_type;
