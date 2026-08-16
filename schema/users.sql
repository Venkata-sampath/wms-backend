DROP TABLE IF EXISTS users;

CREATE TABLE users (
    id TEXT PRIMARY KEY,
    warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
    username TEXT NOT NULL,           
    password_hash TEXT NOT NULL,      
    role TEXT NOT NULL DEFAULT 'operator',
    is_active INTEGER DEFAULT 1,      
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (warehouse_id, username)    
);