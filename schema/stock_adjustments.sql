DROP TABLE IF EXISTS stock_adjustments;

CREATE TABLE stock_adjustments (
    id TEXT PRIMARY KEY,
    warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
    client_id TEXT NOT NULL REFERENCES clients(id),
    stock_owner_id TEXT NOT NULL REFERENCES stock_owners(id),
    location_id TEXT NOT NULL,
    item_code TEXT NOT NULL,
    item_description TEXT NOT NULL,
    batch_number TEXT,
    system_quantity REAL NOT NULL,
    physical_quantity REAL NOT NULL,
    delta_quantity REAL NOT NULL,
    uom TEXT NOT NULL,
    remarks TEXT NOT NULL,
    created_by_user_id TEXT NOT NULL REFERENCES users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);