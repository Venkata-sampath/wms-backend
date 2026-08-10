DROP TABLE IF EXISTS billing;

CREATE TABLE IF NOT EXISTS billing (
    id TEXT PRIMARY KEY,
    warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
    client_id TEXT NOT NULL REFERENCES clients(id),
    invoice_number TEXT NOT NULL,
    invoice_date TEXT NOT NULL,
    due_date TEXT,
    billing_period_from TEXT,
    billing_period_to TEXT,
    reference_number TEXT,
    subtotal REAL NOT NULL DEFAULT 0,
    tax REAL NOT NULL DEFAULT 0,
    discount REAL NOT NULL DEFAULT 0,
    other_charges REAL NOT NULL DEFAULT 0,
    grand_total REAL NOT NULL DEFAULT 0,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'pending',  -- pending | paid
    created_by_user_id TEXT NOT NULL REFERENCES users(id),
    updated_by_user_id TEXT REFERENCES users(id),
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(warehouse_id, invoice_number)
);