DROP TABLE IF EXISTS shipment_line_items;

CREATE TABLE shipment_line_items (
    id TEXT PRIMARY KEY,
    shipment_id TEXT REFERENCES inbound_shipments(id) ON DELETE CASCADE,
    sl_no INTEGER,
    item_code TEXT,
    item_description TEXT NOT NULL,
    hsn_sac TEXT,
    
    ordered_quantity REAL DEFAULT 0,
    uom TEXT,
    rate REAL,
    gross_amount REAL,
    discount_amount REAL,
    taxable_amount REAL,
    tax_rate_percent TEXT,
    cgst REAL,
    sgst REAL,
    igst REAL,
    cess REAL,
    total_amount REAL,

    -- Retained for Manual Ingestion Entry
    category TEXT,
    received_quantity REAL DEFAULT 0,
    damaged_quantity REAL DEFAULT 0,
    shortage_quantity REAL DEFAULT 0,
    excess_quantity REAL DEFAULT 0,
    discrepancy_uom TEXT,
    discrepancy_notes TEXT,
    manufacturing_date TEXT,
    expiry_date TEXT,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);