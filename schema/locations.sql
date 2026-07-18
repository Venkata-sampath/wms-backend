DROP TABLE IF EXISTS locations;

CREATE TABLE locations (
    id TEXT NOT NULL,                -- e.g., 'ZONE-A-RACK-01', 'SHELF-B2'
    warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,      -- Scopes the shelf to a specific company
    status TEXT DEFAULT 'available',    -- 'available' or 'unavailable'
    PRIMARY KEY (id, warehouse_id)   -- Prevents duplicate names within the same warehouse
);