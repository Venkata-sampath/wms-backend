DROP TABLE IF EXISTS shipment_uploads;

CREATE TABLE shipment_uploads (
    id TEXT PRIMARY KEY,
    shipment_type TEXT NOT NULL, -- 'inbound' or 'outbound'
    warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE, -- ISOLATION
    uploaded_by_user_id TEXT REFERENCES users(id),                          -- AUDITING
    status TEXT DEFAULT 'processing', -- 'processing', 'pending_verification', 'completed'
    staging_json TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);