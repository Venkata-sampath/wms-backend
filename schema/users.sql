DROP TABLE IF EXISTS users;

-- B. THE MULTI-TENANT IDENTITY DIRECTORY (Managed by the Warehouse Admin)
CREATE TABLE users (
    id TEXT PRIMARY KEY,
    warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
    username TEXT UNIQUE NOT NULL,      -- Used for logging in
    password_hash TEXT NOT NULL,       -- Cryptographically secured password hash
    role TEXT NOT NULL DEFAULT 'operator', -- 'admin' (Warehouse Admin), 'operator' (Staff)
    is_active INTEGER DEFAULT 1,       -- 1 for active, 0 to revoke access instantly
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);