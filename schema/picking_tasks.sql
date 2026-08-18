DROP TABLE IF EXISTS picking_tasks;

CREATE TABLE picking_tasks (
    id TEXT PRIMARY KEY,
    warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
    client_id TEXT NOT NULL REFERENCES clients(id),
    outbound_shipment_detail_id TEXT NOT NULL REFERENCES outbound_details(id) ON DELETE CASCADE,
    status TEXT DEFAULT 'pending', -- 'pending' or 'completed'
    created_by_user_id TEXT NOT NULL REFERENCES users(id),
    completed_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME
);