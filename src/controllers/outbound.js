import { corsHeaders } from "../utils/response.js";
import { getTenantContext } from "../middleware/authMiddleware.js";
import { generateCloudinarySignature } from "../utils/cloudinary.js";
import { allocateOutboundInventory } from "../jobs/shipmentAggregation.js";

/**
 * @api {POST} /api/outbound/upload
 * @description Uploads outbound shipping documents/images to Cloudinary, logs page references, and pushes them to the OCR pipeline queue for automated digitization.
 * @access Tenant User, Tenant Admin (Super Admins denied)
 *
 * @body {FormData} formData - Multipart form payload:
 * @body {File[]} formData.files - Array of image files representing pages of outbound shipment documents.
 * @body {string[]} [formData.document_types] - Array of corresponding document type labels.
 *
 * @returns {200} JSON - { success: true, shipmentId: string }
 * @returns {400|401|500} JSON - { error: string }
 */
export async function uploadOutboundHandler(request, env) {
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
          "Operation Forbidden: Super Admins must execute document uploads within a specific warehouse context.",
      }),
      { status: 400, headers: corsHeaders },
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

    await env.DB.prepare(
      "INSERT INTO shipment_uploads (id, shipment_type, status, warehouse_id, uploaded_by_user_id) VALUES (?, 'outbound', 'processing', ?, ?)",
    )
      .bind(shipmentId, auth.context.warehouse_id, auth.context.user_id)
      .run();

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const documentType = docTypes[i] || "unknown";

      const pageId = crypto.randomUUID();
      const publicId = `outbound_${shipmentId}_${pageId}`;
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
        "INSERT INTO document_pages (id, shipment_id, image_url, document_type, ocr_status) VALUES (?, ?, ?, ?, 'queued')",
      )
        .bind(pageId, shipmentId, securedUrl, documentType)
        .run();

      await env.OCR_QUEUE.send({
        pageId,
        shipmentId,
        shipmentType: "outbound",
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

/**
 * @api {GET} /api/outbound/pending
 * @description Fetches all in-progress/uncompleted outbound shipment uploads awaiting verification for the authenticated warehouse.
 * @access Tenant User, Tenant Admin
 *
 * @returns {200} JSON - { shipments: Array<{ id: string, status: string, created_at: string }> }
 * @returns {401|500} JSON - { error: string }
 */
export async function getPendingOutboundHandler(request, env) {
  const auth = await getTenantContext(request, env);
  if (!auth.success) {
    return new Response(JSON.stringify({ error: auth.error }), {
      status: auth.status,
      headers: corsHeaders,
    });
  }

  try {
    const pending = await env.DB.prepare(
      "SELECT id, status, created_at FROM shipment_uploads WHERE shipment_type = 'outbound' AND warehouse_id = ? AND status != 'completed' ORDER BY created_at DESC",
    )
      .bind(auth.context.warehouse_id)
      .all();

    return new Response(JSON.stringify({ shipments: pending.results }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: corsHeaders,
    });
  }
}

/**
 * @api {GET} /api/outbound/staged
 * @description Retrieves the parsed staging JSON data of an outbound shipment upload produced by the OCR ingestion pipeline.
 * @access Tenant User, Tenant Admin
 *
 * @query {string} id - The unique UUID of the staged outbound shipment upload.
 *
 * @returns {200} JSON - { id: string, status: string, staging: Object|null }
 * @returns {401|404|500} JSON - { error: string }
 */
export async function getStagedOutboundHandler(request, env) {
  const url = new URL(request.url);
  const auth = await getTenantContext(request, env);
  if (!auth.success) {
    return new Response(JSON.stringify({ error: auth.error }), {
      status: auth.status,
      headers: corsHeaders,
    });
  }

  try {
    const shipmentId = url.searchParams.get("id");
    const shipment = await env.DB.prepare(
      "SELECT id, status, staging_json FROM shipment_uploads WHERE id = ? AND shipment_type = 'outbound' AND warehouse_id = ?",
    )
      .bind(shipmentId, auth.context.warehouse_id)
      .first();

    if (!shipment) {
      return new Response(
        JSON.stringify({ error: "Outbound shipment not found." }),
        { status: 404, headers: corsHeaders },
      );
    }

    return new Response(
      JSON.stringify({
        id: shipment.id,
        status: shipment.status,
        staging: shipment.staging_json
          ? JSON.parse(shipment.staging_json)
          : null,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      },
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: corsHeaders,
    });
  }
}

/**
 * @api {POST} /api/outbound/verify
 * @description Performs pre-commit validation and inventory availability checks (dry-run allocation) across stock owners and locations.
 * @access Tenant User, Tenant Admin (Super Admins denied)
 *
 * @body {string} client_id - Target client UUID.
 * @body {Array<Object>} lineItems - List of outbound items to verify.
 * @body {string} lineItems[].stock_owner_id - Target stock owner UUID.
 * @body {string} lineItems[].item_code - Product/SKU code.
 * @body {string} lineItems[].uom - Unit of measure.
 * @body {number} lineItems[].requested_quantity - Desired quantity to allocate.
 * @body {string} [lineItems[].item_description] - Optional item description.
 *
 * @returns {200} JSON - { success: true, allocations: Array<Object> } or { success: false, errors: string[] }
 * @returns {400|401|500} JSON - { error: string }
 */
export async function verifyOutboundHandler(request, env) {
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
          "Operation Forbidden: Super Admins cannot verify outbound orders.",
      }),
      { status: 400, headers: corsHeaders },
    );
  }

  try {
    const payload = await request.json();
    const { client_id, lineItems } = payload;
    const errors = [];

    if (!client_id) {
      errors.push("Client is required.");
    } else {
      const clientRow = await env.DB.prepare(
        "SELECT id FROM clients WHERE id = ? AND warehouse_id = ?",
      )
        .bind(client_id, auth.context.warehouse_id)
        .first();
      if (!clientRow)
        errors.push("Selected client does not exist for this warehouse.");
    }

    if (!Array.isArray(lineItems) || lineItems.length === 0) {
      errors.push("At least one line item is required.");
    }

    const allocationResults = [];

    if (errors.length === 0 && Array.isArray(lineItems)) {
      for (const item of lineItems) {
        const stock_owner_id = item.stock_owner_id;
        const item_code = String(item.item_code || "").trim();
        const uom = String(item.uom || "").trim();
        const requestedQty =
          parseFloat(String(item.requested_quantity || 0).replace(/,/g, "")) ||
          0;

        if (!stock_owner_id) {
          errors.push(
            `Line item '${item_code || "unknown"}': stock owner is required.`,
          );
          continue;
        }
        if (!item_code) {
          errors.push("A line item is missing its item code.");
          continue;
        }
        if (requestedQty <= 0) {
          errors.push(
            `Line item '${item_code}': requested quantity must be greater than zero.`,
          );
          continue;
        }

        const stockOwnerRow = await env.DB.prepare(
          "SELECT id FROM stock_owners WHERE id = ? AND client_id = ? AND warehouse_id = ?",
        )
          .bind(stock_owner_id, client_id, auth.context.warehouse_id)
          .first();
        if (!stockOwnerRow) {
          errors.push(
            `Line item '${item_code}': stock owner does not belong to the selected client.`,
          );
          continue;
        }

        const { allocations, totalAllocated, shortfall } =
          await allocateOutboundInventory(
            env,
            auth.context.warehouse_id,
            stock_owner_id,
            item_code,
            uom,
            requestedQty,
          );

        if (shortfall > 0.001) {
          errors.push(
            `Line item '${item_code}': insufficient available stock. Requested ${requestedQty} ${uom}, only ${totalAllocated} ${uom} available.`,
          );
        }

        allocationResults.push({
          item_code,
          item_description: item.item_description || "",
          stock_owner_id,
          uom,
          requested_quantity: requestedQty,
          allocated_quantity: totalAllocated,
          allocations,
        });
      }
    }

    if (errors.length > 0) {
      return new Response(JSON.stringify({ success: false, errors }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    return new Response(
      JSON.stringify({ success: true, allocations: allocationResults }),
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

/**
 * @api {POST} /api/outbound/commit
 * @description Commits an outbound shipment order, reserves exact inventory stock rows, generates picking tasks with line items, and registers an audit transaction.
 * @access Tenant User, Tenant Admin (Super Admins denied)
 *
 * @body {string} client_id - Target client UUID.
 * @body {string} [shipmentId] - Optional staged shipment UUID (if originating from AI upload).
 * @body {Object} [header] - Dispatch metadata.
 * @body {string} [header.eway_bill_number] - e-Way bill number.
 * @body {string} [header.transporter_name] - Carrier/transporter name.
 * @body {string} [header.vehicle_number] - Transport vehicle registration number.
 * @body {Array<Object>} lineItems - Final list of outbound item lines to commit and pick.
 * @body {string} lineItems[].stock_owner_id - Target stock owner UUID.
 * @body {string} lineItems[].item_code - Product/SKU code.
 * @body {string} lineItems[].uom - Unit of measure.
 * @body {number} lineItems[].requested_quantity - Desired quantity to fulfill.
 * @body {string} [lineItems[].item_description] - Optional item description.
 *
 * @returns {200} JSON - { success: true, message: string, outbound_detail_id: string, picking_task_id: string, transaction_id: string }
 * @returns {400|401|403|409|500} JSON - { error: string }
 */
export async function commitOutboundHandler(request, env) {
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
          "Operation Forbidden: Super Admins cannot execute outbound commits.",
      }),
      { status: 400, headers: corsHeaders },
    );
  }

  try {
    const payload = await request.json();
    const { shipmentId, client_id, header, lineItems } = payload;

    if (!client_id) {
      return new Response(
        JSON.stringify({
          error: "Client ID must accompany the commit packet.",
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
          error: "Selected Client is invalid for this warehouse.",
        }),
        { status: 403, headers: corsHeaders },
      );
    }

    if (!Array.isArray(lineItems) || lineItems.length === 0) {
      return new Response(
        JSON.stringify({
          error: "At least one line item is required to commit.",
        }),
        { status: 400, headers: corsHeaders },
      );
    }

    // AI-upload shipments carry a shipmentId that must belong to this warehouse.
    // Manual Entry has no prior shipmentId, so this stays null and a fresh
    // outbound_details.id is generated below.
    if (shipmentId) {
      const stagingVerification = await env.DB.prepare(
        "SELECT id FROM shipment_uploads WHERE id = ? AND shipment_type = 'outbound' AND warehouse_id = ?",
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
    }

    // Re-run allocation fresh, right now, against current stock — this is
    // the authoritative check; whatever the client saw at Verify time is
    // discarded.
    const resolvedLineItems = [];
    for (const item of lineItems) {
      const stock_owner_id = item.stock_owner_id;
      const item_code = String(item.item_code || "").trim();
      const uom = String(item.uom || "").trim();
      const requestedQty =
        parseFloat(String(item.requested_quantity || 0).replace(/,/g, "")) || 0;

      const stockOwnerRow = await env.DB.prepare(
        "SELECT id FROM stock_owners WHERE id = ? AND client_id = ? AND warehouse_id = ?",
      )
        .bind(stock_owner_id, client_id, auth.context.warehouse_id)
        .first();
      if (!stockOwnerRow) {
        return new Response(
          JSON.stringify({
            error: `Line item '${item_code}': stock owner does not belong to the selected client.`,
          }),
          { status: 403, headers: corsHeaders },
        );
      }

      const { allocations, totalAllocated, shortfall } =
        await allocateOutboundInventory(
          env,
          auth.context.warehouse_id,
          stock_owner_id,
          item_code,
          uom,
          requestedQty,
        );

      if (shortfall > 0.001) {
        return new Response(
          JSON.stringify({
            error: `Stock changed since verification: '${item_code}' now only has ${totalAllocated} ${uom} available (requested ${requestedQty}). Please re-verify.`,
          }),
          { status: 409, headers: corsHeaders },
        );
      }

      resolvedLineItems.push({
        stock_owner_id,
        item_code,
        item_description: item.item_description || "Unknown Item",
        uom,
        requestedQty,
        allocations,
      });
    }

    const batchStatements = [];
    const outboundDetailId = shipmentId || crypto.randomUUID();

    batchStatements.push(
      env.DB.prepare(
        `INSERT INTO outbound_details
              (id, warehouse_id, client_id, eway_bill_number, transporter_name, vehicle_number, status, created_by_user_id, verified_by_user_id)
             VALUES (?, ?, ?, ?, ?, ?, 'pending_picking', ?, ?)`,
      ).bind(
        outboundDetailId,
        auth.context.warehouse_id,
        client_id,
        String(header?.eway_bill_number || "").trim(),
        String(header?.transporter_name || "").trim(),
        String(header?.vehicle_number || "").trim(),
        auth.context.user_id,
        auth.context.user_id,
      ),
    );

    const pickingTaskId = "pck_" + crypto.randomUUID();
    batchStatements.push(
      env.DB.prepare(
        "INSERT INTO picking_tasks (id, warehouse_id, client_id, outbound_shipment_detail_id, status, created_by_user_id) VALUES (?, ?, ?, ?, 'pending', ?)",
      ).bind(
        pickingTaskId,
        auth.context.warehouse_id,
        client_id,
        outboundDetailId,
        auth.context.user_id,
      ),
    );

    for (const resolved of resolvedLineItems) {
      const lineItemId = crypto.randomUUID();
      batchStatements.push(
        env.DB.prepare(
          `INSERT INTO outbound_line_items
                (id, outbound_detail_id, stock_owner_id, item_code, item_description, uom, requested_quantity)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          lineItemId,
          outboundDetailId,
          resolved.stock_owner_id,
          resolved.item_code,
          resolved.item_description,
          resolved.uom,
          resolved.requestedQty,
        ),
      );

      for (const alloc of resolved.allocations) {
        batchStatements.push(
          env.DB.prepare(
            `INSERT INTO picking_task_items
                  (id, picking_task_id, outbound_shipment_line_item_id, inventory_id, location_id, stock_owner_id, item_code, item_description, batch_number, expiry_date, uom, quantity_to_pick, status)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
          ).bind(
            "pti_" + crypto.randomUUID(),
            pickingTaskId,
            lineItemId,
            alloc.inventory_id,
            alloc.location_id,
            resolved.stock_owner_id,
            resolved.item_code,
            alloc.item_description || resolved.item_description,
            alloc.batch_number,
            alloc.expiry_date,
            alloc.uom,
            alloc.quantity,
          ),
        );

        // Reserve the allocated quantity against the exact inventory row
        batchStatements.push(
          env.DB.prepare(
            "UPDATE inventory SET reserved_quantity = reserved_quantity + ? WHERE id = ? AND warehouse_id = ?",
          ).bind(alloc.quantity, alloc.inventory_id, auth.context.warehouse_id),
        );
      }
    }

    if (shipmentId) {
      batchStatements.push(
        env.DB.prepare(
          "UPDATE shipment_uploads SET status = 'completed', staging_json = NULL WHERE id = ? AND shipment_type = 'outbound' AND warehouse_id = ?",
        ).bind(shipmentId, auth.context.warehouse_id),
      );
    }

    const transactionId = "txn_" + crypto.randomUUID();
    batchStatements.push(
      env.DB.prepare(
        `INSERT INTO transactions (id, warehouse_id, transaction_type, reference_id, status, created_by_user_id, completed_by_user_id, completed_at, remarks, client_id)
             VALUES (?, ?, 'outbound', ?, 'pending_picking', ?, NULL, NULL, NULL, ?)`,
      ).bind(
        transactionId,
        auth.context.warehouse_id,
        outboundDetailId,
        auth.context.user_id,
        client_id,
      ),
    );

    await env.DB.batch(batchStatements);

    return new Response(
      JSON.stringify({
        success: true,
        message: "Outbound commit completed and picking task generated.",
        outbound_detail_id: outboundDetailId,
        picking_task_id: pickingTaskId,
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
