DROP TABLE IF EXISTS stock_adjustment_items;

CREATE TABLE stock_adjustment_items (
    id TEXT PRIMARY KEY,
    stock_adjustment_id TEXT NOT NULL REFERENCES stock_adjustments(id) ON DELETE CASCADE,
    stock_owner_id TEXT NOT NULL REFERENCES stock_owners(id),
    location_id TEXT NOT NULL,
    item_code TEXT NOT NULL,
    item_description TEXT NOT NULL,
    batch_number TEXT,
    uom TEXT NOT NULL,
    system_quantity REAL NOT NULL,
    physical_quantity REAL NOT NULL,
    delta_quantity REAL NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);