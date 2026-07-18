DROP TABLE IF EXISTS document_pages;

CREATE TABLE document_pages (
    id TEXT PRIMARY KEY,
    shipment_id TEXT REFERENCES inbound_shipments(id) ON DELETE CASCADE,
    image_url TEXT NOT NULL,         
    document_type TEXT NOT NULL, -- 'tax_invoice', 'delivery_challan', 'e_way_bill', 'lr'
    extracted_markdown TEXT,
    raw_extracted_json TEXT,
    ocr_status TEXT DEFAULT 'queued',
    llm_status TEXT DEFAULT 'pending',
    ocr_job_id TEXT,
    llm_job_id TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);