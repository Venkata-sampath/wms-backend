DROP TABLE IF EXISTS putaway_task_items;

CREATE TABLE putaway_task_items (
    id TEXT PRIMARY KEY,
    putaway_task_id TEXT NOT NULL REFERENCES putaway_tasks(id) ON DELETE CASCADE,
    shipment_line_item_id TEXT NOT NULL REFERENCES shipment_line_items(id) ON DELETE CASCADE,
    item_code TEXT NOT NULL,
    item_description TEXT NOT NULL,
    uom TEXT NOT NULL,
    quantity_to_place REAL NOT NULL,
    category TEXT NOT NULL,
    expiry_date TEXT,
    manufacturing_date TEXT
);