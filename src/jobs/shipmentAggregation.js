/** AUTHORITATIVE WATERFALL AGGREGATION MODULE (inbound), shared outbound allocation engine, and outbound aggregation module.

Note: allocateOutboundInventory() is also imported directly by controllers/outbound.js (used by /api/outbound/verify and /api/outbound/commit), in addition to being used internally by the LLM-dispatch → aggregation flow in this refactor's job files. **/

export async function aggregateShipmentData(shipmentId, env) {
  const { results } = await env.DB.prepare(
    "SELECT raw_extracted_json, document_type FROM document_pages WHERE shipment_id = ? AND llm_status = 'completed'",
  )
    .bind(shipmentId)
    .all();

  const orderedPriorities = [
    "tax_invoice",
    "delivery_challan",
    "lr",
    "e_way_bill",
  ];

  // Specific document priorities for custom header fields
  const fieldPriorities = {
    e_way_bill_number: ["e_way_bill", "tax_invoice", "delivery_challan", "lr"],
    lr_number: ["lr", "tax_invoice", "delivery_challan", "e_way_bill"],
  };

  // Group all pages by document type into arrays
  const pagesByDocType = {};
  results.forEach((row) => {
    if (row.raw_extracted_json) {
      let parsed;
      try {
        parsed = JSON.parse(row.raw_extracted_json);
      } catch (e) {
        return;
      }
      if (!pagesByDocType[row.document_type]) {
        pagesByDocType[row.document_type] = [];
      }
      pagesByDocType[row.document_type].push(parsed);
    }
  });

  // Rule 1 — Header Fields: doc-type priority, then first non-empty page within that type
  const resolveField = (fieldName) => {
    const priorities = fieldPriorities[fieldName] || orderedPriorities;
    for (const type of priorities) {
      const pages = pagesByDocType[type];
      if (!pages) continue;
      for (const data of pages) {
        if (data && data[fieldName] !== undefined && data[fieldName] !== null) {
          const strVal = String(data[fieldName]).trim();
          if (strVal !== "") return strVal;
        }
      }
    }
    return "";
  };

  // Rule 2 — Parties: Refactored to only 3 roles (seller, bill_to, ship_to)
  // and 3 simplified fields (name, gstin, address).
  const normalizeParty = (partyObj) => {
    // Supports both new schema (name/address) and fallback legacy keys (legal_name/physical_address)
    const rawName = partyObj.name || partyObj.legal_name || "";
    const rawAddress = partyObj.address || partyObj.physical_address || "";
    const rawGstin = partyObj.gstin || "";

    return {
      name: String(rawName).trim(),
      gstin: String(rawGstin).trim().toUpperCase(),
      address: String(rawAddress).trim(),
    };
  };

  const countPopulated = (normalized) =>
    Object.values(normalized).filter((v) => v !== "").length;

  const resolveParty = (partyRole) => {
    let best = null;
    let bestScore = -1;
    let bestPriorityIndex = Infinity;

    orderedPriorities.forEach((type, priorityIndex) => {
      const pages = pagesByDocType[type];
      if (!pages) return;

      pages.forEach((data) => {
        // Support either root-level or nested data.parties structure from LLM output
        const partyData = data?.parties?.[partyRole] || data?.[partyRole];

        if (
          partyData &&
          typeof partyData === "object" &&
          !Array.isArray(partyData)
        ) {
          const normalized = normalizeParty(partyData);
          const score = countPopulated(normalized);
          if (score === 0) return;

          if (
            score > bestScore ||
            (score === bestScore && priorityIndex < bestPriorityIndex)
          ) {
            best = normalized;
            bestScore = score;
            bestPriorityIndex = priorityIndex;
          }
        }
      });
    });

    return (
      best || {
        name: "",
        gstin: "",
        address: "",
      }
    );
  };

  // Rule 3 — Line Items: merge from the first document type with valid line items
  let targetedLineItemsArray = [];
  for (const type of orderedPriorities) {
    const pages = pagesByDocType[type];
    if (!pages) continue;

    const hasLineItems = pages.some(
      (data) =>
        data && Array.isArray(data.line_items) && data.line_items.length > 0,
    );

    if (hasLineItems) {
      targetedLineItemsArray = pages.reduce((acc, data) => {
        if (
          data &&
          Array.isArray(data.line_items) &&
          data.line_items.length > 0
        ) {
          acc.push(...data.line_items);
        }
        return acc;
      }, []);
      break;
    }
  }

  // Aggregate additional_data across raw pages
  let combinedAdditional = [];
  results.forEach((row) => {
    if (!row.raw_extracted_json) return;
    try {
      const data = JSON.parse(row.raw_extracted_json);
      if (
        data.additional_data &&
        typeof data.additional_data === "object" &&
        Object.keys(data.additional_data).length > 0
      ) {
        combinedAdditional.push({
          extracted_from_document_type: row.document_type,
          ...data.additional_data,
        });
      }
    } catch (e) {}
  });

  const completeStagingManifest = {
    header: {
      invoice_number: resolveField("invoice_number"),
      invoice_date: resolveField("invoice_date"),
      po_number: resolveField("po_number"),
      lr_number: resolveField("lr_number"),
      e_way_bill_number: resolveField("e_way_bill_number"),
      vehicle_number: resolveField("vehicle_number"),
      driver_name: resolveField("driver_name"),
      driver_phone_number: resolveField("driver_phone_number"),
    },
    parties: {
      seller: resolveParty("seller"),
      bill_to: resolveParty("bill_to"),
      ship_to: resolveParty("ship_to"),
    },
    lineItems: targetedLineItemsArray.map((item, index) => {
      const rawItemCode = String(item.item_code || "").trim();
      const rawHsnSac = String(item.hsn_sac || "").trim();
      const resolvedItemCode =
        rawItemCode !== "" && rawItemCode === rawHsnSac ? "" : rawItemCode;

      return {
        item_code: resolvedItemCode,
        item_description: item.item_description || "",
        hsn_sac: item.hsn_sac || "",
        ordered_quantity:
          parseFloat(String(item.ordered_quantity || 0).replace(/,/g, "")) || 0,
        uom: item.uom || "PCS",
        rate: parseFloat(String(item.rate || 0).replace(/,/g, "")) || 0,
        gross_amount:
          parseFloat(String(item.gross_amount || 0).replace(/,/g, "")) || 0,
        discount_amount:
          parseFloat(String(item.discount_amount || 0).replace(/,/g, "")) || 0,
        taxable_amount:
          parseFloat(String(item.taxable_amount || 0).replace(/,/g, "")) || 0,
        tax_rate_percent: item.tax_rate_percent || "",
        cgst: parseFloat(String(item.cgst || 0).replace(/,/g, "")) || 0,
        sgst: parseFloat(String(item.sgst || 0).replace(/,/g, "")) || 0,
        igst: parseFloat(String(item.igst || 0).replace(/,/g, "")) || 0,
        cess: parseFloat(String(item.cess || 0).replace(/,/g, "")) || 0,
        total_amount:
          parseFloat(String(item.total_amount || 0).replace(/,/g, "")) || 0,
        received_quantity:
          parseFloat(String(item.ordered_quantity || 0).replace(/,/g, "")) || 0,
        damaged_quantity: 0,
        shortage_quantity: 0,
        excess_quantity: 0,
        discrepancy_uom: item.uom || "PCS",
        discrepancy_notes: "",
        category: "",
        manufacturing_date: "",
        expiry_date: "",
      };
    }),
    additional_data: combinedAdditional,
  };

  await env.DB.prepare(
    "UPDATE shipment_uploads SET staging_json = ?, status = 'pending_verification' WHERE id = ? AND shipment_type = 'inbound'",
  )
    .bind(JSON.stringify(completeStagingManifest), shipmentId)
    .run();
}

// ===========================================================================
// SHARED OUTBOUND ALLOCATION ENGINE — used by both /api/outbound/verify and
// /api/outbound/commit so Commit always recomputes allocation against
// current stock rather than trusting whatever Verify returned earlier.
// FEFO (earliest expiry first) when expiry_date is present, otherwise FIFO
// (oldest created_at first). Read-only: callers decide whether to write.
// ===========================================================================
export async function allocateOutboundInventory(
  env,
  warehouse_id,
  stock_owner_id,
  item_code,
  uom,
  requestedQty,
) {
  const { results: candidateRows } = await env.DB.prepare(
    `SELECT id, location_id, item_code, item_description, uom, batch_number, expiry_date,
            (quantity - reserved_quantity) AS available_quantity
     FROM inventory
     WHERE warehouse_id = ? AND stock_owner_id = ? AND item_code = ?
       AND (quantity - reserved_quantity) > 0
     ORDER BY (expiry_date IS NULL) ASC, expiry_date ASC, created_at ASC`,
  )
    .bind(warehouse_id, stock_owner_id, item_code)
    .all();

  const allocations = [];
  let remaining = requestedQty;

  for (const row of candidateRows) {
    if (remaining <= 0) break;
    if (row.uom !== uom) continue; // UOM mismatch: skip, surfaced as a shortfall to the caller
    const take = Math.min(remaining, row.available_quantity);
    if (take <= 0) continue;
    allocations.push({
      inventory_id: row.id,
      location_id: row.location_id,
      item_description: row.item_description,
      batch_number: row.batch_number,
      expiry_date: row.expiry_date,
      uom: row.uom,
      quantity: take,
    });
    remaining -= take;
  }

  return {
    allocations,
    totalAllocated: requestedQty - remaining,
    shortfall: remaining,
  };
}

// ===========================================================================
// OUTBOUND AGGREGATION MODULE — separate from aggregateShipmentData().
// Outbound documents are a single dispatch/delivery order rather than a
// multi-document waterfall, so this just merges pages in order without the
// inbound doc-type priority logic.
// ===========================================================================
export async function aggregateOutboundShipmentData(shipmentId, env) {
  const { results } = await env.DB.prepare(
    "SELECT raw_extracted_json FROM document_pages WHERE shipment_id = ? AND llm_status = 'completed'",
  )
    .bind(shipmentId)
    .all();

  const parsedPages = [];
  results.forEach((row) => {
    if (!row.raw_extracted_json) return;
    try {
      parsedPages.push(JSON.parse(row.raw_extracted_json));
    } catch (e) {}
  });

  const resolveField = (fieldName) => {
    for (const data of parsedPages) {
      if (data && data[fieldName] !== undefined && data[fieldName] !== null) {
        const strVal = String(data[fieldName]).trim();
        if (strVal !== "") return strVal;
      }
    }
    return "";
  };

  let targetedLineItemsArray = [];
  for (const data of parsedPages) {
    if (data && Array.isArray(data.line_items) && data.line_items.length > 0) {
      targetedLineItemsArray.push(...data.line_items);
    }
  }

  const completeStagingManifest = {
    header: {
      eway_bill_number: resolveField("eway_bill_number"),
      transporter_name: resolveField("transporter_name"),
      vehicle_number: resolveField("vehicle_number"),
      client_name: resolveField("client_name"),
    },
    lineItems: targetedLineItemsArray.map((item) => ({
      item_code: String(item.item_code || "").trim(),
      item_description: item.item_description || "",
      requested_quantity:
        parseFloat(String(item.requested_quantity || 0).replace(/,/g, "")) || 0,
      uom: item.uom || "PCS",
    })),
  };

  await env.DB.prepare(
    "UPDATE shipment_uploads SET staging_json = ?, status = 'pending_verification' WHERE id = ? AND shipment_type = 'outbound'",
  )
    .bind(JSON.stringify(completeStagingManifest), shipmentId)
    .run();
}
