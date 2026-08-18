// LLM DISPATCH — called by llm-queue consumer.

import {
  aggregateShipmentData,
  aggregateOutboundShipmentData,
  determineAggregationPrimary,
} from "./shipmentAggregation.js";

const FULL_SCHEMA_PROMPT = `Convert this OCR markdown into a clean, structured JSON object adhering exactly to the schema blueprint defined below.

GENERAL RULES:
- Do not include any terms and conditions or legal declarations.
- Include all text values exactly as worded in the source. Do not summarize or omit.
- Combine address fragments into a single string representing the complete address. Do not split into city, state, pin etc.
- All keys must be lowercase_snake_case without exception, regardless of how the source document labels the field.
- Return only a single valid JSON block without any explanatory dialogue.

CANONICAL SCHEMA BLUEPRINT:
Your JSON must strictly match this exact template structure. Populate fields if concepts are explicitly present; otherwise, use "" or empty arrays/objects.

{
  "invoice_number": "", 
  "invoice_date": "", 
  "po_number": "", 
  "lr_number": "", 
  "e_way_bill_number": "", 
  "vehicle_number": "", 
  "driver_name": "", 
  "driver_phone_number": "",
  "parties": {
    "seller": { "name": "", "gstin": "", "address": "" },
    "bill_to": { "name": "", "gstin": "", "address": "" },
    "ship_to": { "name": "", "gstin": "", "address": "" }
  },
  "line_items": [ 
    { 
      "item_code": "", 
      "item_description": "", 
      "hsn_sac": "", 
      "ordered_quantity": "", 
      "uom": "", 
      "rate": "", 
      "gross_amount": "", 
      "discount_amount": "", 
      "taxable_amount": "", 
      "tax_rate_percent": "", 
      "cgst": "", 
      "sgst": "", 
      "igst": "", 
      "cess": "", 
      "total_amount": "" 
    } 
  ]
}

FIELD-SPECIFIC ENFORCEMENT RULES:

e_way_bill_number:
- the e way bill number is exactly 12 digit numeric code so dont extract any other number as e way bill number.

lr_number:
- the lr number is also known as the consignment note number. It is usually a combination of letters and numbers, often starting with a prefix that indicates the transport company or region. Extract it as it appears in the document.
- if you find consignment note number in the document, use it as lr_number. If not, search for lr number or consignment number. If none of these are found, leave the field empty.

driver name:
- Extract the driver's name whenever present in the document.
- it is alphabets not numbers. If you find a name that is clearly a person's name, use it. If not, leave the field empty.

driver_phone_number:
- Extract the driver's phone number whenever present in the document.

parties (seller, bill_to, ship_to):
- Extract strictly three party roles: "seller", "bill_to", and "ship_to".
- Every party object MUST strictly contain only these three keys: "name", "gstin", and "address".
- Always uppercase GSTIN strings (e.g., "36AAAAA0000A1Z5").
- If "bill_to" or "ship_to" details are not explicitly distinct from seller/consignor or buyer/consignee in the document, duplicate the seller or buyer details into them accordingly.

line_items:
- item_code: it is not same as hsn_sac. dont automatically copy hsn_sac into item_code if item_code is missing. If item_code is not present, leave it empty.
-hsn_sac: it is not same as item_code. dont automatically copy item_code into hsn_sac if hsn_sac is missing. If hsn_sac is not present, leave it empty.
- Each item row object MUST strictly contain only the keys defined in the line_items schema array.
- ordered_quantity: Must be a clean numeric integer/float string. If the document displays a combined string like "162 00/C S" or "27 00/E A", extract ONLY the numerical value (e.g., "162" or "27").
- uom: Extract the clean Unit of Measure text (e.g., "CS", "CARTONS", "EA", "KG"). Strip away noise characters or layout numbers.
- rate: The individual base price per unit before any discounts or taxes.
- gross_amount: The calculation of rate * quantity before discount.
- discount_amount: Any trade discounts, schemes, or deductions applied to this item row. Set to "0.00" if none.
- taxable_amount: The final tax-eligible value of the line after subtracting discounts, but before adding GST.
- tax_rate_percent: The combined or individual GST percentage rate applied to the row (e.g., "18%", "28%").
- cgst, sgst, igst, cess: The actual calculated currency tax values for that row item. Do not leave blank if zero; use "0.00".
- total_amount: The final grand total for that item row (taxable_amount + taxes).`;

const E_WAY_BILL_PROMPT = `Convert this OCR markdown of an E-Way Bill into a clean, structured JSON object adhering exactly to the schema blueprint defined below.

GENERAL RULES:
- All keys must be lowercase_snake_case without exception.
- Return only a single valid JSON block without any explanatory dialogue.

CANONICAL SCHEMA BLUEPRINT:
{
  "e_way_bill_number": ""
}

FIELD-SPECIFIC ENFORCEMENT RULES:

e_way_bill_number:
- the e way bill number is exactly 12 digit numeric code so dont extract any other number as e way bill number.`;

const LR_PROMPT = `Convert this OCR markdown of a Lorry Receipt (LR) / Consignment Note into a clean, structured JSON object adhering exactly to the schema blueprint defined below.

GENERAL RULES:
- All keys must be lowercase_snake_case without exception.
- Return only a single valid JSON block without any explanatory dialogue.

CANONICAL SCHEMA BLUEPRINT:
{
  "lr_number": ""
}

FIELD-SPECIFIC ENFORCEMENT RULES:

lr_number:
- the lr number is also known as the consignment note number. It is usually a combination of letters and numbers, often starting with a prefix that indicates the transport company or region. Extract it as it appears in the document.
- if you find consignment note number in the document, use it as lr_number. If not, search for lr number or consignment number. If none of these are found, leave the field empty.`;

const PROMPTS = {
  tax_invoice: FULL_SCHEMA_PROMPT,
  delivery_challan: FULL_SCHEMA_PROMPT,
  e_way_bill: E_WAY_BILL_PROMPT,
  lr: LR_PROMPT,
};

export async function handleLlmDispatch(body, env) {
  const { pageId, markdown, shipmentId, documentType } = body;
  const shipmentType =
    body.shipmentType === "outbound" ? "outbound" : "inbound";

  if (shipmentType === "outbound") {
    return handleOutboundLlmDispatch(
      { pageId, markdown, shipmentId, documentType },
      env,
    );
  }

  const SYSTEM_PROMPT = PROMPTS[documentType];
  if (!SYSTEM_PROMPT) {
    throw new Error(
      `Invalid or unsupported inbound document type: ${documentType}`,
    );
  }

  const payload = {
    model: env.MODEL,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: markdown },
    ],
    temperature: 0.0,
    max_tokens: 8192,
    response_format: { type: "json_object" },
    provider: {
      order: ["Groq"],
      allow_fallbacks: false,
    },
  };

  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`OpenRouter LLM call failed: ${resp.status} ${errText}`);
  }

  const result = await resp.json();
  const rawContent = result.choices?.[0]?.message?.content;

  if (!rawContent) {
    await env.DB.prepare(
      "UPDATE document_pages SET llm_status = 'failed' WHERE id = ?",
    )
      .bind(pageId)
      .run();
    return;
  }

  await env.DB.prepare(
    "UPDATE document_pages SET raw_extracted_json = ?, llm_status = 'completed' WHERE id = ?",
  )
    .bind(rawContent, pageId)
    .run();

  const { results: shipmentPages } = await env.DB.prepare(
    "SELECT id, document_type, ocr_status, llm_status FROM document_pages WHERE shipment_id = ?",
  )
    .bind(shipmentId)
    .all();

  const pagesByDocType = {};
  shipmentPages.forEach((p) => {
    if (!pagesByDocType[p.document_type]) {
      pagesByDocType[p.document_type] = [];
    }
    pagesByDocType[p.document_type].push(p);
  });

  const isTerminal = (p) =>
    p.llm_status === "completed" ||
    p.llm_status === "failed" ||
    p.ocr_status === "failed";

  const primaryDocType = determineAggregationPrimary(pagesByDocType);

  if (!primaryDocType) {
    await env.DB.prepare(
      "UPDATE shipment_uploads SET status = 'failed' WHERE id = ?",
    )
      .bind(shipmentId)
      .run();
    return;
  }

  const primaryPages = pagesByDocType[primaryDocType];
  const hasCompletedPrimary = primaryPages.some(
    (p) => p.llm_status === "completed",
  );

  if (hasCompletedPrimary) {
    const allNonPrimaryTerminal = shipmentPages
      .filter((p) => p.document_type !== primaryDocType)
      .every(isTerminal);

    if (allNonPrimaryTerminal) {
      await aggregateShipmentData(shipmentId, env);
    }
  } else {
    const allPrimaryTerminal = primaryPages.every(isTerminal);
    if (allPrimaryTerminal) {
      await env.DB.prepare(
        "UPDATE shipment_uploads SET status = 'failed' WHERE id = ?",
      )
        .bind(shipmentId)
        .run();
    }
  }
}

// ==========================================
// OUTBOUND LLM DISPATCH — called by handleLlmDispatch() when shipmentType === 'outbound'
// Reuses the same OCR markdown + OpenRouter call pattern as the inbound path,
// with an outbound-specific extraction schema (dispatch/delivery order rather
// than a tax invoice), and aggregates via aggregateOutboundShipmentData().
// ==========================================
export async function handleOutboundLlmDispatch(body, env) {
  const { pageId, markdown, shipmentId, documentType } = body;

  const OUTBOUND_SYSTEM_PROMPT = `Convert this OCR markdown of an outbound dispatch document into a clean, structured JSON object adhering exactly to the schema blueprint defined below.

GENERAL RULES:
- Do not include any terms and conditions or legal declarations.
- Include all text values exactly as worded in the source. Do not summarize or omit.
- All keys must be lowercase_snake_case without exception, regardless of how the source document labels the field.
- Return only a single valid JSON block without any explanatory dialogue.

CANONICAL SCHEMA BLUEPRINT:
{
  "eway_bill_number": "",
  "transporter_name": "",
  "vehicle_number": "",
  "client_name": "",
  "line_items": [
    {
      "item_code": "",
      "item_description": "",
      "requested_quantity": "",
      "uom": ""
    }
  ]
}

FIELD-SPECIFIC ENFORCEMENT RULES:

eway_bill_number:
- the e way bill number is exactly 12 digit numeric code so dont extract any other number as e way bill number.

line_items:
- requested_quantity: Must be a clean numeric integer/float string. Strip away any unit noise (e.g. "50 CS" -> "50").
- uom: Extract the clean Unit of Measure text (e.g., "CS", "CARTONS", "EA", "KG").`;

  const payload = {
    model: env.MODEL,
    messages: [
      { role: "system", content: OUTBOUND_SYSTEM_PROMPT },
      { role: "user", content: markdown },
    ],
    temperature: 0.0,
    max_tokens: 8192,
    response_format: { type: "json_object" },
    provider: {
      order: ["Groq"],
      allow_fallbacks: false,
    },
  };

  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`OpenRouter LLM call failed: ${resp.status} ${errText}`);
  }

  const result = await resp.json();
  const rawContent = result.choices?.[0]?.message?.content;

  if (!rawContent) {
    await env.DB.prepare(
      "UPDATE document_pages SET llm_status = 'failed' WHERE id = ?",
    )
      .bind(pageId)
      .run();
    return;
  }

  await env.DB.prepare(
    "UPDATE document_pages SET raw_extracted_json = ?, llm_status = 'completed' WHERE id = ?",
  )
    .bind(rawContent, pageId)
    .run();

  const { results: shipmentPages } = await env.DB.prepare(
    "SELECT id, llm_status FROM document_pages WHERE shipment_id = ?",
  )
    .bind(shipmentId)
    .all();

  if (shipmentPages.every((p) => p.llm_status === "completed")) {
    await aggregateOutboundShipmentData(shipmentId, env);
  }
}
