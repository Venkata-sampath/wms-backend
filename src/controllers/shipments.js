import { corsHeaders } from "../utils/response.js";
import { getTenantContext } from "../middleware/authMiddleware.js";
import { generateCloudinarySignature } from "../utils/cloudinary.js";

// =========================================================================
// ENDPOINT 1: Fetch Staged Shipment Data for verification UI (SECURED)
// GET /api/shipments/staged
// =========================================================================
export async function getStagedShipmentHandler(request, env) {
  const url = new URL(request.url);
  const auth = await getTenantContext(request, env);
  if (!auth.success) {
    return new Response(JSON.stringify({ error: auth.error }), {
      status: auth.status,
      headers: corsHeaders,
    });
  }

  const shipmentId = url.searchParams.get("id");

  // Multi-tenant check: A Super Admin sees all; an operator/admin is locked to their warehouse_id
  const data = await env.DB.prepare(
    `
        SELECT id, status, staging_json 
        FROM inbound_shipments 
        WHERE id = ? AND (? = 'super_admin' OR warehouse_id = ?)
      `,
  )
    .bind(shipmentId, auth.context.role, auth.context.warehouse_id)
    .first();

  if (!data) {
    return new Response(
      JSON.stringify({
        error: "Shipment Not Found or Access Unauthorized",
      }),
      {
        status: 404,
        headers: corsHeaders,
      },
    );
  }

  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// =========================================================================
// ENDPOINT 3: Inbound Upload Endpoint (SECURED WITH CONTEXT)
// POST /api/inbound/upload
// =========================================================================
export async function uploadInboundShipmentHandler(request, env) {
  const auth = await getTenantContext(request, env);
  if (!auth.success) {
    return new Response(JSON.stringify({ error: auth.error }), {
      status: auth.status,
      headers: corsHeaders,
    });
  }

  // Safeguard: Prevent Super Admin from uploading staging items into global space without explicit warehouse scoping
  if (auth.context.role === "super_admin") {
    return new Response(
      JSON.stringify({
        error:
          "Operation Forbidden: Super Admins must execute document uploads within a specific warehouse context.",
      }),
      {
        status: 400,
        headers: corsHeaders,
      },
    );
  }

  try {
    const formData = await request.formData();
    const files = formData.getAll("files");
    const docTypes = formData.getAll("document_types");

    if (files.length === 0) {
      return new Response(JSON.stringify({ error: "No files detected" }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    const shipmentId = crypto.randomUUID();

    // Security Injection: Insert and lock this processing stream straight to the caller's warehouse account
    await env.DB.prepare(
      "INSERT INTO inbound_shipments (id, status, warehouse_id, uploaded_by_user_id) VALUES (?, 'processing', ?, ?)",
    )
      .bind(shipmentId, auth.context.warehouse_id, auth.context.user_id) // Add user_id here
      .run();

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const documentType = docTypes[i] || "unknown";

      const pageId = crypto.randomUUID();
      const publicId = `shipments_${shipmentId}_${pageId}`;
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const signature = await generateCloudinarySignature(
        publicId,
        timestamp,
        env.CLOUDINARY_API_SECRET,
      );

      const cloudinaryFormData = new FormData();
      cloudinaryFormData.append("file", file);
      cloudinaryFormData.append("public_id", publicId);
      cloudinaryFormData.append("timestamp", timestamp);
      cloudinaryFormData.append("api_key", env.CLOUDINARY_API_KEY);
      cloudinaryFormData.append("signature", signature);

      const cloudResponse = await fetch(
        `https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/image/upload`,
        { method: "POST", body: cloudinaryFormData },
      );
      const cloudResult = await cloudResponse.json();
      if (!cloudResponse.ok)
        throw new Error(cloudResult.error?.message || "Cloudinary failed");

      const securedUrl = cloudResult.secure_url;

      await env.DB.prepare(
        "INSERT INTO document_pages (id, shipment_id, shipment_type, image_url, document_type, ocr_status) VALUES (?, ?, 'inbound', ?, ?, 'queued')",
      )
        .bind(pageId, shipmentId, securedUrl, documentType)
        .run();

      // Forward the multi-tenant context boundary downstream through our queue processing message context
      await env.OCR_QUEUE.send({
        pageId,
        shipmentId,
        shipmentType: "inbound",
        warehouseId: auth.context.warehouse_id,
        imageUrl: securedUrl,
        documentType,
      });
    }

    return new Response(JSON.stringify({ success: true, shipmentId }), {
      status: 200,
      headers: corsHeaders,
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: corsHeaders,
    });
  }
}

// =========================================================================
// OCR Webhook Endpoint
// POST /api/ocr/webhook
// =========================================================================
export async function ocrWebhookHandler(request, env) {
  const authHeader = request.headers.get("Authorization");
  if (authHeader !== `Bearer ${env.OCR_POD_API_KEY}`) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: corsHeaders,
    });
  }

  try {
    const payload = await request.json();
    const markdown = payload.output?.[0]?.choices?.[0]?.message?.content;
    const jobId = payload.id;

    if (!markdown) {
      await env.DB.prepare(
        "UPDATE document_pages SET ocr_status = 'failed' WHERE ocr_job_id = ?",
      )
        .bind(jobId)
        .run();
      return new Response(JSON.stringify({ received: true }), {
        headers: corsHeaders,
      });
    }

    const page = await env.DB.prepare(
      "SELECT id, shipment_id, shipment_type, document_type FROM document_pages WHERE ocr_job_id = ?",
    )
      .bind(jobId)
      .first();

    if (!page) {
      return new Response(JSON.stringify({ error: "Unknown job_id" }), {
        status: 404,
        headers: corsHeaders,
      });
    }

    await env.DB.prepare(
      "UPDATE document_pages SET extracted_markdown = ?, ocr_status = 'completed', llm_status = 'queued' WHERE id = ?",
    )
      .bind(markdown, page.id)
      .run();

    await env.LLM_QUEUE.send({
      pageId: page.id,
      markdown,
      shipmentId: page.shipment_id,
      shipmentType: page.shipment_type,
      documentType: page.document_type,
    });

    return new Response(JSON.stringify({ received: true }), {
      headers: corsHeaders,
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: corsHeaders,
    });
  }
}

// =========================================================================
// ENDPOINT 4: Verification Commit Transaction Endpoint (SECURED WITH AUDIT TRAIL)
// POST /api/shipments/commit
// =========================================================================
export async function commitShipmentHandler(request, env) {
  const auth = await getTenantContext(request, env);
  if (!auth.success) {
    return new Response(JSON.stringify({ error: auth.error }), {
      status: auth.status,
      headers: corsHeaders,
    });
  }

  if (auth.context.role === "super_admin") {
    return new Response(
      JSON.stringify({
        error:
          "Operation Forbidden: Super Admins cannot execute final shipping ledgers.",
      }),
      { status: 400, headers: corsHeaders },
    );
  }

  try {
    const payload = await request.json();
    const {
      shipmentId,
      client_id,
      stock_owner_id,
      header,
      parties,
      lineItems,
    } = payload;

    if (!client_id || !stock_owner_id) {
      return new Response(
        JSON.stringify({
          error:
            "Relational failure: Both Client ID and Stock Owner ID must accompany the verification packet.",
        }),
        { status: 400, headers: corsHeaders },
      );
    }

    const clientVerification = await env.DB.prepare(
      "SELECT id FROM clients WHERE id = ? AND warehouse_id = ?",
    )
      .bind(client_id, auth.context.warehouse_id)
      .first();

    if (!clientVerification) {
      return new Response(
        JSON.stringify({
          error:
            "Verification rejected: Selected Client context record mismatch or invalid assignment.",
        }),
        { status: 403, headers: corsHeaders },
      );
    }

    const stockOwnerVerification = await env.DB.prepare(
      "SELECT id FROM stock_owners WHERE id = ? AND client_id = ? AND warehouse_id = ?",
    )
      .bind(stock_owner_id, client_id, auth.context.warehouse_id)
      .first();

    if (!stockOwnerVerification) {
      return new Response(
        JSON.stringify({
          error:
            "Verification rejected: Selected Stock Owner is invalid or does not belong to the designated client.",
        }),
        { status: 403, headers: corsHeaders },
      );
    }

    const stagingVerification = await env.DB.prepare(
      "SELECT id FROM inbound_shipments WHERE id = ? AND warehouse_id = ?",
    )
      .bind(shipmentId, auth.context.warehouse_id)
      .first();

    if (!stagingVerification) {
      return new Response(
        JSON.stringify({
          error:
            "Unauthorized manipulation attempt detected. Record access denied.",
        }),
        { status: 403, headers: corsHeaders },
      );
    }

    const roles = ["seller", "bill_to", "ship_to"];
    let resolvedPartyIds = {};

    for (const role of roles) {
      const party = parties?.[role];
      if (!party || !party.gstin || String(party.gstin).trim() === "") {
        resolvedPartyIds[role] = null;
        continue;
      }

      const cleanGstin = String(party.gstin).trim().toUpperCase();
      if (cleanGstin.length !== 15) {
        return new Response(
          JSON.stringify({
            error: `Invalid GSTIN for role '${role}'. Must be exactly 15 characters long.`,
          }),
          { status: 400, headers: corsHeaders },
        );
      }

      let existingParty = await env.DB.prepare(
        "SELECT id FROM parties WHERE gstin = ? AND warehouse_id = ?",
      )
        .bind(cleanGstin, auth.context.warehouse_id)
        .first();

      if (existingParty) {
        resolvedPartyIds[role] = existingParty.id;
      } else {
        const newPartyId = crypto.randomUUID();
        await env.DB.prepare(
          "INSERT INTO parties (id, warehouse_id, name, gstin, address) VALUES (?, ?, ?, ?, ?)",
        )
          .bind(
            newPartyId,
            auth.context.warehouse_id,
            String(party.name || "").trim(),
            cleanGstin,
            String(party.address || "").trim(),
          )
          .run();

        resolvedPartyIds[role] = newPartyId;
      }
    }

    const cleanFloat = (val) => {
      if (val === undefined || val === null || String(val).trim() === "")
        return 0;
      const parsed = parseFloat(String(val).replace(/,/g, ""));
      return isNaN(parsed) ? 0 : parsed;
    };

    const cleanDateField = (val) => {
      if (val === undefined || val === null) return null;
      const trimmed = String(val).trim();
      return trimmed === "" ? null : trimmed;
    };

    const cleanBatchNumber = (val) => {
      if (val === undefined || val === null) return null;
      const trimmed = String(val).trim();
      return trimmed === "" ? null : trimmed;
    };

    const VALID_ITEM_CATEGORIES = new Set(["frozen", "chiller", "ambient"]);
    const cleanCategory = (val) => {
      if (val === undefined || val === null) {
        throw new Error(
          "Each line item must have a category (frozen, chiller, or ambient).",
        );
      }
      const normalized = String(val).trim().toLowerCase();
      if (!VALID_ITEM_CATEGORIES.has(normalized)) {
        throw new Error(
          `Invalid category '${val}'. Must be one of: frozen, chiller, ambient.`,
        );
      }
      return normalized;
    };

    const batchStatements = [];

    // Idempotency cleanups
    batchStatements.push(
      env.DB.prepare(
        "DELETE FROM shipment_details WHERE id = ? AND warehouse_id = ?",
      ).bind(shipmentId, auth.context.warehouse_id),
    );
    batchStatements.push(
      env.DB.prepare(
        "DELETE FROM shipment_line_items WHERE shipment_id = ? AND shipment_id IN (SELECT id FROM inbound_shipments WHERE warehouse_id = ?)",
      ).bind(shipmentId, auth.context.warehouse_id),
    );
    batchStatements.push(
      env.DB.prepare(
        "DELETE FROM putaway_task_items WHERE putaway_task_id IN (SELECT id FROM putaway_tasks WHERE shipment_id = ? AND warehouse_id = ?)",
      ).bind(shipmentId, auth.context.warehouse_id),
    );
    batchStatements.push(
      env.DB.prepare(
        "DELETE FROM putaway_tasks WHERE shipment_id = ? AND warehouse_id = ?",
      ).bind(shipmentId, auth.context.warehouse_id),
    );
    batchStatements.push(
      env.DB.prepare(
        "DELETE FROM transactions WHERE reference_id = ? AND warehouse_id = ? AND transaction_type = 'inbound'",
      ).bind(shipmentId, auth.context.warehouse_id),
    );

    // Write shipment_details + client_id + stock_owner_id
    batchStatements.push(
      env.DB.prepare(
        `INSERT INTO shipment_details (
      id, invoice_number, invoice_date, po_number, lr_number, e_way_bill_number, vehicle_number, driver_name, driver_phone_number,
      seller_party_id, bill_to_party_id, ship_to_party_id, additional_data, warehouse_id, verified_by_user_id, client_id, stock_owner_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        shipmentId,
        String(header.invoice_number || "").trim(),
        String(header.invoice_date || "").trim(),
        String(header.po_number || "").trim(),
        String(header.lr_number || "").trim(),
        String(header.e_way_bill_number || "").trim(),
        String(header.vehicle_number || "").trim(),
        String(header.driver_name || "").trim(),
        String(header.driver_phone_number || "").trim(),
        resolvedPartyIds.seller,
        resolvedPartyIds.bill_to,
        resolvedPartyIds.ship_to,
        payload.additional_data
          ? JSON.stringify(payload.additional_data)
          : null,
        auth.context.warehouse_id,
        auth.context.user_id,
        client_id,
        stock_owner_id,
      ),
    );

    // Create putaway_tasks + client_id
    const putawayTaskId = "ptk_" + crypto.randomUUID();
    batchStatements.push(
      env.DB.prepare(
        "INSERT INTO putaway_tasks (id, warehouse_id, shipment_id, status, client_id) VALUES (?, ?, ?, 'pending', ?)",
      ).bind(putawayTaskId, auth.context.warehouse_id, shipmentId, client_id),
    );

    if (Array.isArray(lineItems)) {
      for (const item of lineItems) {
        const resolvedCategory = cleanCategory(item.category);
        const resolvedManufacturingDate = cleanDateField(
          item.manufacturing_date,
        );
        const resolvedExpiryDate = cleanDateField(item.expiry_date);
        const resolvedBatchNumber = cleanBatchNumber(item.batch_number);
        const lineItemId = crypto.randomUUID();
        const verifiedUom = String(item.uom || "PCS").trim();

        batchStatements.push(
          env.DB.prepare(
            `INSERT INTO shipment_line_items (
          id, shipment_id, item_code, item_description, hsn_sac, ordered_quantity, uom, rate, gross_amount,
          discount_amount, taxable_amount, tax_rate_percent, cgst, sgst, igst, cess, total_amount, category,
          received_quantity, damaged_quantity, shortage_quantity, excess_quantity, discrepancy_uom, discrepancy_notes,
          manufacturing_date, expiry_date, batch_number, case_conversion_qty
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            lineItemId,
            shipmentId,
            String(item.item_code || "").trim(),
            String(item.item_description || "Unknown Item").trim(),
            String(item.hsn_sac || "").trim(),
            cleanFloat(item.ordered_quantity),
            verifiedUom,
            cleanFloat(item.rate),
            cleanFloat(item.gross_amount),
            cleanFloat(item.discount_amount),
            cleanFloat(item.taxable_amount),
            String(item.tax_rate_percent || "").trim(),
            cleanFloat(item.cgst),
            cleanFloat(item.sgst),
            cleanFloat(item.igst),
            cleanFloat(item.cess),
            cleanFloat(item.total_amount),
            resolvedCategory,
            cleanFloat(item.received_quantity),
            cleanFloat(item.damaged_quantity),
            cleanFloat(item.shortage_quantity),
            cleanFloat(item.excess_quantity),
            String(item.discrepancy_uom || item.uom || "PCS").trim(),
            String(item.discrepancy_notes || "").trim(),
            resolvedManufacturingDate,
            resolvedExpiryDate,
            resolvedBatchNumber,
            cleanFloat(item.case_conversion_qty),
          ),
        );

        const targetPutawayQty = cleanFloat(item.received_quantity);
        if (targetPutawayQty > 0) {
          batchStatements.push(
            env.DB.prepare(
              `INSERT INTO putaway_task_items (id, putaway_task_id, item_code, item_description, quantity_to_place, category, expiry_date, manufacturing_date, shipment_line_item_id, uom, batch_number)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).bind(
              "pti_" + crypto.randomUUID(),
              putawayTaskId,
              String(item.item_code || "").trim(),
              String(item.item_description || "Unknown Item").trim(),
              targetPutawayQty,
              resolvedCategory,
              resolvedExpiryDate,
              resolvedManufacturingDate,
              lineItemId,
              verifiedUom,
              resolvedBatchNumber,
            ),
          );
        }
      }
    }

    batchStatements.push(
      env.DB.prepare(
        "UPDATE inbound_shipments SET status = 'completed', staging_json = NULL WHERE id = ? AND warehouse_id = ?",
      ).bind(shipmentId, auth.context.warehouse_id),
    );

    // Create transactions + client_id
    const transactionId = "txn_" + crypto.randomUUID();
    batchStatements.push(
      env.DB.prepare(
        `INSERT INTO transactions (id, warehouse_id, transaction_type, reference_id, status, created_by_user_id, completed_by_user_id, completed_at, remarks, client_id)
     VALUES (?, ?, 'inbound', ?, 'pending_putaway', ?, NULL, NULL, NULL, ?)`,
      ).bind(
        transactionId,
        auth.context.warehouse_id,
        shipmentId,
        auth.context.user_id,
        client_id,
      ),
    );

    await env.DB.batch(batchStatements);

    return new Response(
      JSON.stringify({
        success: true,
        message:
          "Commit transaction completed securely and putaway task generated.",
        putaway_task_id: putawayTaskId,
        transaction_id: transactionId,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      },
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
}

// =========================================================================
// GET /api/shipments/pending
// =========================================================================
export async function getPendingShipmentsHandler(request, env) {
  const auth = await getTenantContext(request, env);
  if (!auth.success) {
    return new Response(JSON.stringify({ error: auth.error }), {
      status: auth.status,
      headers: corsHeaders,
    });
  }

  // Fetch only active/pending work for the current warehouse, enriched with
  // uploader identity and timestamp so the frontend queue is more useful.
  const shipments = await env.DB.prepare(
    `
        SELECT s.id, s.status, s.created_at, s.uploaded_by_user_id, u.username AS uploaded_by_username
        FROM inbound_shipments s
        LEFT JOIN users u ON s.uploaded_by_user_id = u.id
        WHERE s.warehouse_id = ? AND s.status IN ('processing', 'pending_verification')
        ORDER BY s.created_at DESC
        `,
  )
    .bind(auth.context.warehouse_id)
    .all();

  return new Response(JSON.stringify(shipments.results), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
