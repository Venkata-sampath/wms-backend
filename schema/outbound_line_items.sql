DROP TABLE IF EXISTS outbound_line_items;

CREATE TABLE outbound_line_items (
    id TEXT PRIMARY KEY,
    outbound_detail_id TEXT NOT NULL REFERENCES outbound_details(id) ON DELETE CASCADE,
    stock_owner_id TEXT NOT NULL REFERENCES stock_owners(id),
    item_code TEXT NOT NULL,
    item_description TEXT NOT NULL,
    uom TEXT NOT NULL,
    requested_quantity REAL NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);