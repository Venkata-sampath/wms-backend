DROP TABLE IF EXISTS opening_stock_imports;

CREATE TABLE IF NOT EXISTS opening_stock_imports (
    id TEXT PRIMARY KEY,
    warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
    client_id TEXT NOT NULL REFERENCES clients(id),
    stock_owner_id TEXT NOT NULL REFERENCES stock_owners(id),
    uploaded_by_user_id TEXT NOT NULL REFERENCES users(id),
    total_rows INTEGER NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);