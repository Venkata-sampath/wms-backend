DROP TABLE IF EXISTS billing;

CREATE TABLE IF NOT EXISTS billing (
    id TEXT PRIMARY KEY,
    warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
    client_id TEXT NOT NULL REFERENCES clients(id),

    -- Invoice identity
    invoice_number TEXT NOT NULL,
    invoice_date TEXT NOT NULL,
    due_date TEXT,
    billing_period_from TEXT,
    billing_period_to TEXT,
    reference_number TEXT,
    reference_date TEXT,

    -- Dispatch / delivery block
    buyers_order_no TEXT,
    buyers_order_date TEXT,
    dispatch_doc_no TEXT,
    dispatch_through TEXT,
    destination TEXT,
    terms_of_delivery TEXT,
    delivery_note TEXT,
    delivery_note_date TEXT,

    -- Warehouse (seller) snapshot — frozen at time of bill, editable per bill
    wh_company_name TEXT,
    wh_gstin TEXT,
    wh_address TEXT,
    wh_state_name TEXT,
    wh_state_code TEXT,
    wh_fssai TEXT,
    wh_bank_name TEXT,
    wh_account_number TEXT,
    wh_branch_ifsc TEXT,

    -- Buyer snapshot — frozen at time of bill, editable per bill
    buyer_name TEXT,
    buyer_gstin TEXT,
    buyer_address TEXT,
    buyer_contact TEXT,
    buyer_phone TEXT,
    buyer_email TEXT,
    buyer_state_name TEXT,
    buyer_state_code TEXT,
    place_of_supply TEXT,

    -- Tax computation
    tax_type TEXT NOT NULL DEFAULT 'intra',  -- 'intra' (CGST+SGST) | 'inter' (IGST)
    subtotal REAL NOT NULL DEFAULT 0,
    cgst_amount REAL NOT NULL DEFAULT 0,
    sgst_amount REAL NOT NULL DEFAULT 0,
    igst_amount REAL NOT NULL DEFAULT 0,
    round_off REAL NOT NULL DEFAULT 0,
    discount REAL NOT NULL DEFAULT 0,
    other_charges REAL NOT NULL DEFAULT 0,
    grand_total REAL NOT NULL DEFAULT 0,

    notes TEXT,
    other_ref TEXT,
    status TEXT NOT NULL DEFAULT 'pending',  -- pending | paid
    created_by_user_id TEXT NOT NULL REFERENCES users(id),
    updated_by_user_id TEXT REFERENCES users(id),
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(warehouse_id, invoice_number)
);