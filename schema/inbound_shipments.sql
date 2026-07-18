DROP TABLE IF EXISTS inbound_shipments;

CREATE TABLE inbound_shipments (
    id TEXT PRIMARY KEY,
    warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE, -- ISOLATION
    uploaded_by_user_id TEXT REFERENCES users(id),                          -- AUDITING
    status TEXT DEFAULT 'processing',
    staging_json TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);