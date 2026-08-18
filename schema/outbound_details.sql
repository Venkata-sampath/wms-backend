DROP TABLE IF EXISTS outbound_details;

CREATE TABLE outbound_details (
    id TEXT PRIMARY KEY, -- for AI uploads this equals shipment_uploads.id; for manual entry it is freshly generated
    warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
    client_id TEXT NOT NULL REFERENCES clients(id),
    eway_bill_number TEXT,
    transporter_name TEXT,
    vehicle_number TEXT,
    status TEXT DEFAULT 'pending_picking', -- 'pending_picking' or 'completed'
    created_by_user_id TEXT NOT NULL REFERENCES users(id),
    verified_by_user_id TEXT REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);