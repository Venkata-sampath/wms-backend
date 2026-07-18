DROP TABLE IF EXISTS transactions;

CREATE TABLE transactions (
    id TEXT PRIMARY KEY,

    warehouse_id TEXT NOT NULL,

    transaction_type TEXT NOT NULL,
    reference_id TEXT NOT NULL,

    status TEXT NOT NULL,

    created_by_user_id TEXT,
    completed_by_user_id TEXT,

    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,

    remarks TEXT
);
