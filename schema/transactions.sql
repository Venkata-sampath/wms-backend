DROP TABLE IF EXISTS transactions;

CREATE TABLE transactions (
    id TEXT PRIMARY KEY,
    warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
    transaction_type TEXT NOT NULL,
    reference_id TEXT NOT NULL,
    status TEXT NOT NULL,
    created_by_user_id TEXT NOT NULL REFERENCES users(id),
    completed_by_user_id TEXT REFERENCES users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    remarks TEXT
);
