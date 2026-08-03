DROP TABLE IF EXISTS billing_items;

CREATE TABLE IF NOT EXISTS billing_items (
    id TEXT PRIMARY KEY,
    billing_id TEXT NOT NULL REFERENCES billing(id) ON DELETE CASCADE,
    description TEXT NOT NULL,
    quantity REAL,
    unit TEXT,
    rate REAL,
    amount REAL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);