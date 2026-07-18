DROP TABLE IF EXISTS inventory;

CREATE TABLE inventory (
    id TEXT PRIMARY KEY,
    warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
    location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    item_code TEXT NOT NULL,
    item_description TEXT,
    quantity REAL NOT NULL,
    expiry_date TEXT,
    -- Generated column: maps NULL expiry_date -> '' so that two "no expiry"
    -- batches of the same item/location still collide (and merge) under the
    -- UNIQUE constraint below, while two different real expiry dates (or a
    -- null vs. a real date) are treated as distinct batches with separate rows.
    expiry_key TEXT GENERATED ALWAYS AS (COALESCE(expiry_date, '')) STORED,
    UNIQUE(warehouse_id, location_id, item_code, expiry_key)
);