DROP TABLE IF EXISTS putaway_task_items;

CREATE TABLE putaway_task_items (
    id TEXT PRIMARY KEY,
    putaway_task_id TEXT NOT NULL,
    item_code TEXT NOT NULL,
    item_description TEXT,
    quantity_to_place REAL NOT NULL,
    category TEXT,
    expiry_date TEXT,
    manufacturing_date TEXT
);