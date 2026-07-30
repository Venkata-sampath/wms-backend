DROP TABLE IF EXISTS picking_task_items;

CREATE TABLE picking_task_items (
    id TEXT PRIMARY KEY,
    picking_task_id TEXT NOT NULL REFERENCES picking_tasks(id) ON DELETE CASCADE,
    outbound_shipment_line_item_id TEXT NOT NULL REFERENCES outbound_shipment_line_items(id) ON DELETE CASCADE,
    inventory_id TEXT NOT NULL REFERENCES inventory(id),
    location_id TEXT NOT NULL,
    stock_owner_id TEXT NOT NULL REFERENCES stock_owners(id),
    item_code TEXT NOT NULL,
    item_description TEXT NOT NULL,
    batch_number TEXT,
    expiry_date TEXT,
    uom TEXT NOT NULL,
    quantity_to_pick REAL NOT NULL,
    status TEXT DEFAULT 'pending', -- 'pending' or 'picked'
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);