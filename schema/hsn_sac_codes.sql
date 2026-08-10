DROP TABLE IF EXISTS hsn_sac_codes;

CREATE TABLE IF NOT EXISTS hsn_sac_codes (
    id TEXT PRIMARY KEY,
    warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
    code TEXT NOT NULL,
    tax_percentage REAL NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(warehouse_id, code)
);