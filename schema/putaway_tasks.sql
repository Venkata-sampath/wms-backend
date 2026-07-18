DROP TABLE IF EXISTS putaway_tasks;

CREATE TABLE putaway_tasks (
    id TEXT PRIMARY KEY,
    warehouse_id TEXT NOT NULL,
    shipment_id TEXT NOT NULL,
    status TEXT DEFAULT 'pending',   -- 'pending' or 'completed'
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);