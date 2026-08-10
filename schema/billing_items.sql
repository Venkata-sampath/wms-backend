DROP TABLE IF EXISTS billing_main_items;

CREATE TABLE IF NOT EXISTS billing_main_items (
    id TEXT PRIMARY KEY,
    billing_id TEXT NOT NULL REFERENCES billing(id) ON DELETE CASCADE,
    main_description TEXT NOT NULL,   -- e.g. "Cooling Charges-18%"
    hsn_sac TEXT NOT NULL,            -- e.g. "992971"
    tax_rate REAL NOT NULL DEFAULT 0, -- combined GST rate, e.g. 18
    amount REAL NOT NULL DEFAULT 0,   -- sum of this main item's sub_items amounts
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);