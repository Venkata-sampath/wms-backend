DROP TABLE IF EXISTS inbound_details;

CREATE TABLE inbound_details (
    id TEXT PRIMARY KEY, -- for AI uploads this equals shipment_uploads.id; for manual entry it is freshly generated
    warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
    stock_owner_id TEXT NOT NULL REFERENCES stock_owners(id),
    verified_by_user_id TEXT NOT NULL REFERENCES users(id),      
    client_id TEXT NOT NULL REFERENCES clients(id),         
    invoice_number TEXT,      
    invoice_date TEXT,        
    po_number TEXT,           
    lr_number TEXT,           
    e_way_bill_number TEXT,   
    vehicle_number TEXT,      
    driver_name TEXT,         
    driver_phone_number TEXT, 
    bill_to_party_id TEXT REFERENCES parties(id),
    ship_to_party_id TEXT REFERENCES parties(id),
    seller_party_id TEXT REFERENCES parties(id),
    additional_data TEXT,     
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);