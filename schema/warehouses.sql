DROP TABLE IF EXISTS warehouses;

-- A. THE TENANT DIRECTORY (Created virtually by you when they subscribe)
CREATE TABLE warehouses (
    id TEXT PRIMARY KEY,               -- e.g., 'wh_01j2abc345xyz...' (Secure Unique ID)
    company_name TEXT NOT NULL,         -- The billing legal name of the subscriber
    gstin TEXT,                         -- Warehouse's own GSTIN, used on generated invoices
    address TEXT,                       -- Warehouse's own postal address, used on generated invoices
    subscription_status TEXT DEFAULT 'active', -- 'active', 'suspended', 'trial'
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);