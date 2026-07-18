DROP TABLE IF EXISTS parties;

CREATE TABLE parties (
    id TEXT PRIMARY KEY,
    warehouse_id TEXT NOT NULL,
    name TEXT NOT NULL,
    gstin TEXT NOT NULL,
    address TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unq_warehouse_gstin UNIQUE (warehouse_id, gstin)
);

