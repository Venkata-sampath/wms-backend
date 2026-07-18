DROP TABLE IF EXISTS shipment_details;

CREATE TABLE shipment_details (
    id TEXT PRIMARY KEY REFERENCES inbound_shipments(id) ON DELETE CASCADE,
    warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE, -- ISOLATION
    verified_by_user_id TEXT NOT NULL REFERENCES users(id),               

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