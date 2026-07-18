DROP TABLE IF EXISTS warehouses;

-- A. THE TENANT DIRECTORY (Created virtually by you when they subscribe)
CREATE TABLE warehouses (
    id TEXT PRIMARY KEY,               -- e.g., 'wh_01j2abc345xyz...' (Secure Unique ID)
    company_name TEXT NOT NULL,         -- The billing legal name of the subscriber
    subscription_status TEXT DEFAULT 'active', -- 'active', 'suspended', 'trial'
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);