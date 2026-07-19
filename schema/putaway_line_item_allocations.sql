DROP TABLE IF EXISTS putaway_task_item_allocations;

CREATE TABLE IF NOT EXISTS putaway_task_item_allocations (
    id TEXT PRIMARY KEY,
    warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
    putaway_task_item_id TEXT NOT NULL REFERENCES putaway_task_items(id) ON DELETE CASCADE,
    location_id TEXT NOT NULL,
    quantity REAL NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (location_id, warehouse_id) REFERENCES locations(id, warehouse_id) ON DELETE CASCADE
);