DROP TABLE IF EXISTS putaway_tasks;

CREATE TABLE putaway_tasks (
    id TEXT PRIMARY KEY,
    warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
    shipment_id TEXT NOT NULL REFERENCES inbound_shipments(id) ON DELETE CASCADE,
    status TEXT DEFAULT 'pending',   -- 'pending' or 'completed'
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);