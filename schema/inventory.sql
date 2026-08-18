DROP TABLE IF EXISTS inventory;

CREATE TABLE inventory (
    id TEXT PRIMARY KEY,
    inventory_source TEXT NOT NULL,
    source_reference_id TEXT NOT NULL,
    shipment_line_item_id TEXT REFERENCES inbound_line_items(id) ON DELETE CASCADE,
    warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
    client_id TEXT NOT NULL REFERENCES clients(id),
    stock_owner_id TEXT NOT NULL REFERENCES stock_owners(id),
    location_id TEXT NOT NULL, 
    item_code TEXT NOT NULL,
    item_description TEXT NOT NULL,
    quantity REAL NOT NULL,
    reserved_quantity REAL NOT NULL DEFAULT 0,
    uom TEXT NOT NULL,
    category TEXT NOT NULL,
    manufacturing_date TEXT,
    expiry_date TEXT,
    batch_number TEXT,
    case_conversion_qty REAL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (location_id, warehouse_id) REFERENCES locations(id, warehouse_id) ON DELETE CASCADE
);