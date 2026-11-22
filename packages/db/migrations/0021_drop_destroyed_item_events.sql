-- ITEM_DESTROYED events (components combined into an item, consumables used, items transforming)
-- were nearly half of item_events and never read: builds come from PURCHASED / UNDO and the item
-- data. The worker no longer stores them. The enum keeps its 'DESTROYED' value (an enum value
-- cannot be dropped while views use the column).
--
-- On a large table this takes minutes, and the space is reused by new rows rather than returned
-- to the disk (VACUUM FULL item_events returns it).

DELETE FROM item_events WHERE type = 'DESTROYED';
