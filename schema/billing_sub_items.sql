DROP TABLE IF EXISTS billing_sub_items;

CREATE TABLE IF NOT EXISTS billing_sub_items (
    id TEXT PRIMARY KEY,
    main_item_id TEXT NOT NULL REFERENCES billing_main_items(id) ON DELETE CASCADE,
    sub_description TEXT,             -- e.g. "159 Pallets X 1450/- Per Pallet"
    quantity REAL,
    unit TEXT,
    rate REAL,
    amount REAL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);