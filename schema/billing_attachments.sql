DROP TABLE IF EXISTS billing_attachments;

CREATE TABLE IF NOT EXISTS billing_attachments (
    id TEXT PRIMARY KEY,
    billing_id TEXT NOT NULL REFERENCES billing(id) ON DELETE CASCADE,
    file_name TEXT NOT NULL,
    file_url TEXT NOT NULL,
    cloudinary_public_id TEXT NOT NULL,
    cloudinary_resource_type TEXT NOT NULL DEFAULT 'raw', -- 'image' or 'raw', required by Cloudinary to correctly destroy the asset later
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);