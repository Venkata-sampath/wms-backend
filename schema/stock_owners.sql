DROP TABLE IF EXISTS stock_owners;

CREATE TABLE IF NOT EXISTS stock_owners (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    code TEXT NOT NULL,
    gstin TEXT,
    contact_person TEXT,
    phone TEXT,
    email TEXT,
    status TEXT DEFAULT 'active',
    created_by_user_id TEXT REFERENCES users(id),
    updated_by_user_id TEXT REFERENCES users(id),
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(warehouse_id, code)
);
