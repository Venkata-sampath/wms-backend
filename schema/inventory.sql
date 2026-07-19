DROP TABLE IF EXISTS inventory;

CREATE TABLE inventory (
    id TEXT PRIMARY KEY,
    shipment_line_item_id TEXT NOT NULL REFERENCES shipment_line_items(id) ON DELETE CASCADE,
    putaway_task_item_id TEXT REFERENCES putaway_task_items(id) ON DELETE SET NULL, -- Added Nullable FK
    warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
    location_id TEXT NOT NULL, 
    item_code TEXT NOT NULL,
    item_description TEXT NOT NULL,
    quantity REAL NOT NULL,
    uom TEXT NOT NULL,
    category TEXT NOT NULL,
    manufacturing_date TEXT,
    expiry_date TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (location_id, warehouse_id) REFERENCES locations(id, warehouse_id) ON DELETE CASCADE
);