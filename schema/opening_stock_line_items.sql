DROP TABLE IF EXISTS opening_stock_line_items;

CREATE TABLE IF NOT EXISTS opening_stock_line_items (
    id TEXT PRIMARY KEY,
    opening_stock_import_id TEXT NOT NULL REFERENCES opening_stock_imports(id) ON DELETE CASCADE,
    item_code TEXT NOT NULL,
    item_description TEXT NOT NULL,
    quantity REAL NOT NULL,
    uom TEXT NOT NULL,
    category TEXT NOT NULL,
    batch_number TEXT,
    manufacturing_date TEXT,
    expiry_date TEXT,
    location_id TEXT NOT NULL REFERENCES locations(id),
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);