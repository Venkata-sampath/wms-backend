DROP TABLE IF EXISTS clients;

CREATE TABLE IF NOT EXISTS clients (
    id TEXT PRIMARY KEY,
    warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    code TEXT NOT NULL,
    gstin TEXT,
    contact_person TEXT,
    phone TEXT,
    email TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_by_user_id TEXT NOT NULL REFERENCES users(id),
    updated_by_user_id TEXT REFERENCES users(id),
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(warehouse_id, code)
);