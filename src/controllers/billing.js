import { corsHeaders } from "../utils/response.js";
import { getTenantContext } from "../middleware/authMiddleware.js";
import { generateCloudinarySignature, destroyCloudinaryAsset } from "../utils/cloudinary.js";

// -------------------------------------------------------------------------
// GET /api/billing -> List bills for this warehouse (filters: search, client_id, status)
// -------------------------------------------------------------------------
export async function getBillingHandler(request, env) {
  const url = new URL(request.url);
  const auth = await getTenantContext(request, env);
  if (!auth.success) {
    return new Response(JSON.stringify({ error: auth.error }), {
      status: auth.status,
      headers: corsHeaders,
    });
  }
  if (auth.context.role !== "admin") {
    return new Response(
      JSON.stringify({
        error: "Operation Forbidden: Admin access required.",
      }),
      { status: 403, headers: corsHeaders },
    );
  }

  try {
    const search = (url.searchParams.get("search") || "").trim();
    const clientId = url.searchParams.get("client_id") || "";
    const status = url.searchParams.get("status") || "";

    let query = `
          SELECT b.*, c.name AS client_name, c.code AS client_code
          FROM billing b
          JOIN clients c ON b.client_id = c.id
          WHERE b.warehouse_id = ?
        `;
    const binds = [auth.context.warehouse_id];

    if (search) {
      query += " AND (b.invoice_number LIKE ? OR c.name LIKE ?)";
      binds.push(`%${search}%`, `%${search}%`);
    }
    if (clientId) {
      query += " AND b.client_id = ?";
      binds.push(clientId);
    }
    if (status === "pending" || status === "paid") {
      query += " AND b.status = ?";
      binds.push(status);
    }
    query += " ORDER BY b.created_at DESC";

    const rows = await env.DB.prepare(query)
      .bind(...binds)
      .all();
    return new Response(JSON.stringify({ bills: rows.results || [] }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}

// -------------------------------------------------------------------------
// POST /api/billing -> Create a new bill
// -------------------------------------------------------------------------
export async function createBillHandler(request, env) {
  const auth = await getTenantContext(request, env);
  if (!auth.success) {
    return new Response(JSON.stringify({ error: auth.error }), {
      status: auth.status,
      headers: corsHeaders,
    });
  }
  if (auth.context.role !== "admin") {
    return new Response(
      JSON.stringify({
        error: "Operation Forbidden: Admin access required.",
      }),
      { status: 403, headers: corsHeaders },
    );
  }

  try {
    const payload = await request.json();
    const client_id = String(payload.client_id || "").trim();
    const invoice_number = String(payload.invoice_number || "").trim();
    const invoice_date = String(payload.invoice_date || "").trim();
    const due_date = payload.due_date
      ? String(payload.due_date).trim()
      : null;
    const billing_period_from = payload.billing_period_from
      ? String(payload.billing_period_from).trim()
      : null;
    const billing_period_to = payload.billing_period_to
      ? String(payload.billing_period_to).trim()
      : null;
    const reference_number = payload.reference_number
      ? String(payload.reference_number).trim()
      : null;
    const reference_date = payload.reference_date
      ? String(payload.reference_date).trim()
      : null;
    const subtotal = Number(payload.subtotal) || 0;
    const discount = Number(payload.discount) || 0;
    const other_charges = Number(payload.other_charges) || 0;
    const grand_total = Number(payload.grand_total) || 0;
    const round_off = Number(payload.round_off) || 0;
    const notes = payload.notes ? String(payload.notes).trim() : null;
    const other_ref = payload.other_ref
      ? String(payload.other_ref).trim()
      : null;
    const items = Array.isArray(payload.items) ? payload.items : [];

    // Dispatch/delivery block
    const buyers_order_no = payload.buyers_order_no
      ? String(payload.buyers_order_no).trim()
      : null;
    const buyers_order_date = payload.buyers_order_date
      ? String(payload.buyers_order_date).trim()
      : null;
    const dispatch_doc_no = payload.dispatch_doc_no
      ? String(payload.dispatch_doc_no).trim()
      : null;
    const dispatch_through = payload.dispatch_through
      ? String(payload.dispatch_through).trim()
      : null;
    const destination = payload.destination
      ? String(payload.destination).trim()
      : null;
    const terms_of_delivery = payload.terms_of_delivery
      ? String(payload.terms_of_delivery).trim()
      : null;
    const delivery_note = payload.delivery_note
      ? String(payload.delivery_note).trim()
      : null;
    const delivery_note_date = payload.delivery_note_date
      ? String(payload.delivery_note_date).trim()
      : null;

    // Warehouse (seller) snapshot
    const wh_company_name = payload.wh_company_name
      ? String(payload.wh_company_name).trim()
      : null;
    const wh_gstin = payload.wh_gstin
      ? String(payload.wh_gstin).trim()
      : null;
    const wh_address = payload.wh_address
      ? String(payload.wh_address).trim()
      : null;
    const wh_state_name = payload.wh_state_name
      ? String(payload.wh_state_name).trim()
      : null;
    const wh_state_code = payload.wh_state_code
      ? String(payload.wh_state_code).trim()
      : null;
    const wh_fssai = payload.wh_fssai
      ? String(payload.wh_fssai).trim()
      : null;
    const wh_bank_name = payload.wh_bank_name
      ? String(payload.wh_bank_name).trim()
      : null;
    const wh_account_number = payload.wh_account_number
      ? String(payload.wh_account_number).trim()
      : null;
    const wh_branch_ifsc = payload.wh_branch_ifsc
      ? String(payload.wh_branch_ifsc).trim()
      : null;
    const wh_contact = payload.wh_contact
      ? String(payload.wh_contact).trim()
      : null;
    const wh_email = payload.wh_email
      ? String(payload.wh_email).trim()
      : null;

    // Buyer snapshot
    const buyer_name = payload.buyer_name
      ? String(payload.buyer_name).trim()
      : null;
    const buyer_gstin = payload.buyer_gstin
      ? String(payload.buyer_gstin).trim()
      : null;
    const buyer_address = payload.buyer_address
      ? String(payload.buyer_address).trim()
      : null;
    const buyer_state_name = payload.buyer_state_name
      ? String(payload.buyer_state_name).trim()
      : null;
    const buyer_state_code = payload.buyer_state_code
      ? String(payload.buyer_state_code).trim()
      : null;
    const place_of_supply = payload.place_of_supply
      ? String(payload.place_of_supply).trim()
      : null;

    const tax_type = payload.tax_type === "inter" ? "inter" : "intra";
    const cgst_amount = Number(payload.cgst_amount) || 0;
    const sgst_amount = Number(payload.sgst_amount) || 0;
    const igst_amount = Number(payload.igst_amount) || 0;

    if (!client_id || !invoice_number || !invoice_date) {
      return new Response(
        JSON.stringify({
          error:
            "Client, Invoice Number, and Invoice Date are mandatory fields.",
        }),
        { status: 400, headers: corsHeaders },
      );
    }
    if (items.length === 0) {
      return new Response(
        JSON.stringify({ error: "At least one billing item is required." }),
        { status: 400, headers: corsHeaders },
      );
    }

    const clientRow = await env.DB.prepare(
      "SELECT id FROM clients WHERE id = ? AND warehouse_id = ?",
    )
      .bind(client_id, auth.context.warehouse_id)
      .first();
    if (!clientRow) {
      return new Response(
        JSON.stringify({
          error: "Selected client was not found in this warehouse.",
        }),
        { status: 400, headers: corsHeaders },
      );
    }

    const existingBill = await env.DB.prepare(
      "SELECT id FROM billing WHERE warehouse_id = ? AND invoice_number = ?",
    )
      .bind(auth.context.warehouse_id, invoice_number)
      .first();
    if (existingBill) {
      return new Response(
        JSON.stringify({
          error: `Invoice Number '${invoice_number}' is already in use in this warehouse. Please use a different Invoice Number.`,
        }),
        { status: 409, headers: corsHeaders },
      );
    }

    const billingId = "bill_" + crypto.randomUUID();

    const batchStatements = [
      env.DB.prepare(
        `INSERT INTO billing (
              id, warehouse_id, client_id, invoice_number, invoice_date, due_date,
              billing_period_from, billing_period_to, reference_number, reference_date,
              buyers_order_no, buyers_order_date, dispatch_doc_no, dispatch_through,
              destination, terms_of_delivery, delivery_note, delivery_note_date,
              wh_company_name, wh_gstin, wh_address, wh_state_name, wh_state_code,
              wh_fssai, wh_bank_name, wh_account_number, wh_branch_ifsc, wh_contact, wh_email,
              buyer_name, buyer_gstin, buyer_address, buyer_state_name, buyer_state_code, place_of_supply,
              tax_type, subtotal, cgst_amount, sgst_amount, igst_amount, round_off,
              discount, other_charges, grand_total, notes, other_ref,
              status, created_by_user_id, updated_by_user_id
            ) VALUES (
              ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
              ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
              ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
              ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
              ?, ?, ?, ?, ?, ?, ?, ?, ?
            )`,
      ).bind(
        billingId,
        auth.context.warehouse_id,
        client_id,
        invoice_number,
        invoice_date,
        due_date,
        billing_period_from,
        billing_period_to,
        reference_number,
        reference_date,
        buyers_order_no,
        buyers_order_date,
        dispatch_doc_no,
        dispatch_through,
        destination,
        terms_of_delivery,
        delivery_note,
        delivery_note_date,
        wh_company_name,
        wh_gstin,
        wh_address,
        wh_state_name,
        wh_state_code,
        wh_fssai,
        wh_bank_name,
        wh_account_number,
        wh_branch_ifsc,
        wh_contact,
        wh_email,
        buyer_name,
        buyer_gstin,
        buyer_address,
        buyer_state_name,
        buyer_state_code,
        place_of_supply,
        tax_type,
        subtotal,
        cgst_amount,
        sgst_amount,
        igst_amount,
        round_off,
        discount,
        other_charges,
        grand_total,
        notes,
        other_ref,
        "pending",
        auth.context.user_id,
        null,
      ),
    ];

    items.forEach((item, idx) => {
      const mainItemId = "bmi_" + crypto.randomUUID();
      batchStatements.push(
        env.DB.prepare(
          `INSERT INTO billing_main_items (id, billing_id, main_description, hsn_sac, tax_rate, amount, sort_order)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          mainItemId,
          billingId,
          String(item.main_description || item.description || "").trim(),
          String(item.hsn_sac || "").trim(),
          Number(item.tax_rate) || 0,
          Number(item.amount) || 0,
          idx,
        ),
      );

      const subItems = Array.isArray(item.sub_items) ? item.sub_items : [];
      subItems.forEach((sub, subIdx) => {
        const subItemId = "bsi_" + crypto.randomUUID();
        batchStatements.push(
          env.DB.prepare(
            `INSERT INTO billing_sub_items (id, main_item_id, sub_description, quantity, unit, rate, amount, sort_order)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            subItemId,
            mainItemId,
            sub.sub_description ? String(sub.sub_description).trim() : null,
            sub.quantity !== undefined &&
              sub.quantity !== null &&
              sub.quantity !== ""
              ? Number(sub.quantity)
              : null,
            sub.unit ? String(sub.unit).trim() : null,
            sub.rate !== undefined && sub.rate !== null && sub.rate !== ""
              ? Number(sub.rate)
              : null,
            sub.amount !== undefined &&
              sub.amount !== null &&
              sub.amount !== ""
              ? Number(sub.amount)
              : null,
            subIdx,
          ),
        );
      });
    });

    await env.DB.batch(batchStatements);

    return new Response(
      JSON.stringify({
        success: true,
        message: "Bill created successfully.",
        billing_id: billingId,
      }),
      {
        status: 201,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}

// -------------------------------------------------------------------------
// POST /api/billing/:id/attachments -> Upload one supporting file to Cloudinary
// -------------------------------------------------------------------------
export async function uploadBillingAttachmentHandler(request, env, matchParams) {
  const auth = await getTenantContext(request, env);
  if (!auth.success) {
    return new Response(JSON.stringify({ error: auth.error }), {
      status: auth.status,
      headers: corsHeaders,
    });
  }
  if (auth.context.role !== "admin") {
    return new Response(
      JSON.stringify({
        error: "Operation Forbidden: Admin access required.",
      }),
      { status: 403, headers: corsHeaders },
    );
  }

  try {
    const billingId = matchParams[1];
    const billRow = await env.DB.prepare(
      "SELECT id FROM billing WHERE id = ? AND warehouse_id = ?",
    )
      .bind(billingId, auth.context.warehouse_id)
      .first();
    if (!billRow) {
      return new Response(JSON.stringify({ error: "Bill not found." }), {
        status: 404,
        headers: corsHeaders,
      });
    }

    const formData = await request.formData();
    const file = formData.get("file");
    if (!file) {
      return new Response(JSON.stringify({ error: "No file provided." }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    const isImage = (file.type || "").startsWith("image/");
    const resourceType = isImage ? "image" : "raw";
    const attachmentId = "att_" + crypto.randomUUID();
    const publicId = `billing_attachments/${billingId}_${attachmentId}`;
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
      `https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/${resourceType}/upload`,
      { method: "POST", body: cloudinaryFormData },
    );
    const cloudResult = await cloudResponse.json();
    if (!cloudResponse.ok) {
      throw new Error(
        cloudResult.error?.message || "Cloudinary upload failed",
      );
    }

    await env.DB.prepare(
      `INSERT INTO billing_attachments (id, billing_id, file_name, file_url, cloudinary_public_id, cloudinary_resource_type)
           VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        attachmentId,
        billingId,
        file.name || "attachment",
        cloudResult.secure_url,
        publicId,
        resourceType,
      )
      .run();

    return new Response(
      JSON.stringify({
        success: true,
        attachment: {
          id: attachmentId,
          file_name: file.name || "attachment",
          file_url: cloudResult.secure_url,
        },
      }),
      {
        status: 201,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}

// -------------------------------------------------------------------------
// DELETE /api/billing/attachments/:id -> Remove one attachment (Cloudinary + DB)
// -------------------------------------------------------------------------
export async function deleteBillingAttachmentHandler(request, env, matchParams) {
  const auth = await getTenantContext(request, env);
  if (!auth.success) {
    return new Response(JSON.stringify({ error: auth.error }), {
      status: auth.status,
      headers: corsHeaders,
    });
  }
  if (auth.context.role !== "admin") {
    return new Response(
      JSON.stringify({
        error: "Operation Forbidden: Admin access required.",
      }),
      { status: 403, headers: corsHeaders },
    );
  }

  try {
    const attachmentId = matchParams[1];
    const attachmentRow = await env.DB.prepare(
      `SELECT a.id, a.cloudinary_public_id, a.cloudinary_resource_type
           FROM billing_attachments a
           JOIN billing b ON a.billing_id = b.id
           WHERE a.id = ? AND b.warehouse_id = ?`,
    )
      .bind(attachmentId, auth.context.warehouse_id)
      .first();

    if (!attachmentRow) {
      return new Response(
        JSON.stringify({ error: "Attachment not found." }),
        {
          status: 404,
          headers: corsHeaders,
        },
      );
    }

    await destroyCloudinaryAsset(
      attachmentRow.cloudinary_public_id,
      attachmentRow.cloudinary_resource_type,
      env,
    );

    await env.DB.prepare("DELETE FROM billing_attachments WHERE id = ?")
      .bind(attachmentId)
      .run();

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}

// -------------------------------------------------------------------------
// POST /api/billing/:id/mark-paid -> One-way status transition, pending -> paid
// -------------------------------------------------------------------------
export async function markBillPaidHandler(request, env, matchParams) {
  const auth = await getTenantContext(request, env);
  if (!auth.success) {
    return new Response(JSON.stringify({ error: auth.error }), {
      status: auth.status,
      headers: corsHeaders,
    });
  }
  if (auth.context.role !== "admin") {
    return new Response(
      JSON.stringify({
        error: "Operation Forbidden: Admin access required.",
      }),
      { status: 403, headers: corsHeaders },
    );
  }

  try {
    const billingId = matchParams[1];
    const billRow = await env.DB.prepare(
      "SELECT id, status FROM billing WHERE id = ? AND warehouse_id = ?",
    )
      .bind(billingId, auth.context.warehouse_id)
      .first();

    if (!billRow) {
      return new Response(JSON.stringify({ error: "Bill not found." }), {
        status: 404,
        headers: corsHeaders,
      });
    }
    if (billRow.status === "paid") {
      return new Response(
        JSON.stringify({ error: "This bill is already marked as paid." }),
        { status: 400, headers: corsHeaders },
      );
    }

    await env.DB.prepare(
      "UPDATE billing SET status = 'paid', updated_by_user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    )
      .bind(auth.context.user_id, billingId)
      .run();

    return new Response(
      JSON.stringify({ success: true, message: "Bill marked as paid." }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}

// -------------------------------------------------------------------------
// GET /api/billing/:id -> Bill details, with items and attachments joined in
// -------------------------------------------------------------------------
export async function getBillDetailHandler(request, env, matchParams) {
  const auth = await getTenantContext(request, env);
  if (!auth.success) {
    return new Response(JSON.stringify({ error: auth.error }), {
      status: auth.status,
      headers: corsHeaders,
    });
  }
  if (auth.context.role !== "admin") {
    return new Response(
      JSON.stringify({
        error: "Operation Forbidden: Admin access required.",
      }),
      { status: 403, headers: corsHeaders },
    );
  }

  try {
    const billingId = matchParams[1];
    const bill = await env.DB.prepare(
      `SELECT b.*, c.name AS client_name, c.code AS client_code, c.gstin AS client_gstin,
                  c.contact_person AS client_contact_person, c.phone AS client_phone, c.email AS client_email
           FROM billing b
           JOIN clients c ON b.client_id = c.id
           WHERE b.id = ? AND b.warehouse_id = ?`,
    )
      .bind(billingId, auth.context.warehouse_id)
      .first();

    if (!bill) {
      return new Response(JSON.stringify({ error: "Bill not found." }), {
        status: 404,
        headers: corsHeaders,
      });
    }

    const mainItemsRes = await env.DB.prepare(
      "SELECT id, main_description, hsn_sac, tax_rate, amount, sort_order FROM billing_main_items WHERE billing_id = ? ORDER BY sort_order ASC, created_at ASC",
    )
      .bind(billingId)
      .all();
    const mainItemRows = mainItemsRes.results || [];

    let subItemRows = [];
    if (mainItemRows.length > 0) {
      const mainIds = mainItemRows.map((m) => m.id);
      const placeholders = mainIds.map(() => "?").join(",");
      const subItemsRes = await env.DB.prepare(
        `SELECT id, main_item_id, sub_description, quantity, unit, rate, amount, sort_order
             FROM billing_sub_items WHERE main_item_id IN (${placeholders})
             ORDER BY sort_order ASC, created_at ASC`,
      )
        .bind(...mainIds)
        .all();
      subItemRows = subItemsRes.results || [];
    }

    const items = mainItemRows.map((m) => ({
      id: m.id,
      main_description: m.main_description,
      hsn_sac: m.hsn_sac,
      tax_rate: m.tax_rate,
      amount: m.amount,
      sub_items: subItemRows
        .filter((s) => s.main_item_id === m.id)
        .map((s) => ({
          id: s.id,
          sub_description: s.sub_description,
          quantity: s.quantity,
          unit: s.unit,
          rate: s.rate,
          amount: s.amount,
        })),
    }));

    const attachments = await env.DB.prepare(
      "SELECT id, file_name, file_url, created_at FROM billing_attachments WHERE billing_id = ? ORDER BY created_at ASC",
    )
      .bind(billingId)
      .all();

    return new Response(
      JSON.stringify({
        bill,
        items,
        attachments: attachments.results || [],
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}

// -------------------------------------------------------------------------
// PUT /api/billing/:id -> Edit a bill (only while status = 'pending')
// -------------------------------------------------------------------------
export async function updateBillHandler(request, env, matchParams) {
  const auth = await getTenantContext(request, env);
  if (!auth.success) {
    return new Response(JSON.stringify({ error: auth.error }), {
      status: auth.status,
      headers: corsHeaders,
    });
  }
  if (auth.context.role !== "admin") {
    return new Response(
      JSON.stringify({
        error: "Operation Forbidden: Admin access required.",
      }),
      { status: 403, headers: corsHeaders },
    );
  }

  try {
    const billingId = matchParams[1];
    const existingBill = await env.DB.prepare(
      "SELECT id, status, invoice_number FROM billing WHERE id = ? AND warehouse_id = ?",
    )
      .bind(billingId, auth.context.warehouse_id)
      .first();

    if (!existingBill) {
      return new Response(JSON.stringify({ error: "Bill not found." }), {
        status: 404,
        headers: corsHeaders,
      });
    }
    if (existingBill.status === "paid") {
      return new Response(
        JSON.stringify({
          error: "This bill has been paid and can no longer be edited.",
        }),
        { status: 403, headers: corsHeaders },
      );
    }

    const payload = await request.json();
    const client_id = String(payload.client_id || "").trim();
    const invoice_number = String(payload.invoice_number || "").trim();
    const invoice_date = String(payload.invoice_date || "").trim();
    const due_date = payload.due_date
      ? String(payload.due_date).trim()
      : null;
    const billing_period_from = payload.billing_period_from
      ? String(payload.billing_period_from).trim()
      : null;
    const billing_period_to = payload.billing_period_to
      ? String(payload.billing_period_to).trim()
      : null;
    const reference_number = payload.reference_number
      ? String(payload.reference_number).trim()
      : null;
    const reference_date = payload.reference_date
      ? String(payload.reference_date).trim()
      : null;
    const subtotal = Number(payload.subtotal) || 0;
    const discount = Number(payload.discount) || 0;
    const other_charges = Number(payload.other_charges) || 0;
    const grand_total = Number(payload.grand_total) || 0;
    const round_off = Number(payload.round_off) || 0;
    const notes = payload.notes ? String(payload.notes).trim() : null;
    const other_ref = payload.other_ref
      ? String(payload.other_ref).trim()
      : null;
    const items = Array.isArray(payload.items) ? payload.items : [];

    const buyers_order_no = payload.buyers_order_no
      ? String(payload.buyers_order_no).trim()
      : null;
    const buyers_order_date = payload.buyers_order_date
      ? String(payload.buyers_order_date).trim()
      : null;
    const dispatch_doc_no = payload.dispatch_doc_no
      ? String(payload.dispatch_doc_no).trim()
      : null;
    const dispatch_through = payload.dispatch_through
      ? String(payload.dispatch_through).trim()
      : null;
    const destination = payload.destination
      ? String(payload.destination).trim()
      : null;
    const terms_of_delivery = payload.terms_of_delivery
      ? String(payload.terms_of_delivery).trim()
      : null;
    const delivery_note = payload.delivery_note
      ? String(payload.delivery_note).trim()
      : null;
    const delivery_note_date = payload.delivery_note_date
      ? String(payload.delivery_note_date).trim()
      : null;

    const wh_company_name = payload.wh_company_name
      ? String(payload.wh_company_name).trim()
      : null;
    const wh_gstin = payload.wh_gstin
      ? String(payload.wh_gstin).trim()
      : null;
    const wh_address = payload.wh_address
      ? String(payload.wh_address).trim()
      : null;
    const wh_state_name = payload.wh_state_name
      ? String(payload.wh_state_name).trim()
      : null;
    const wh_state_code = payload.wh_state_code
      ? String(payload.wh_state_code).trim()
      : null;
    const wh_fssai = payload.wh_fssai
      ? String(payload.wh_fssai).trim()
      : null;
    const wh_bank_name = payload.wh_bank_name
      ? String(payload.wh_bank_name).trim()
      : null;
    const wh_account_number = payload.wh_account_number
      ? String(payload.wh_account_number).trim()
      : null;
    const wh_branch_ifsc = payload.wh_branch_ifsc
      ? String(payload.wh_branch_ifsc).trim()
      : null;
    const wh_contact = payload.wh_contact
      ? String(payload.wh_contact).trim()
      : null;
    const wh_email = payload.wh_email
      ? String(payload.wh_email).trim()
      : null;

    const buyer_name = payload.buyer_name
      ? String(payload.buyer_name).trim()
      : null;
    const buyer_gstin = payload.buyer_gstin
      ? String(payload.buyer_gstin).trim()
      : null;
    const buyer_address = payload.buyer_address
      ? String(payload.buyer_address).trim()
      : null;
    const buyer_state_name = payload.buyer_state_name
      ? String(payload.buyer_state_name).trim()
      : null;
    const buyer_state_code = payload.buyer_state_code
      ? String(payload.buyer_state_code).trim()
      : null;
    const place_of_supply = payload.place_of_supply
      ? String(payload.place_of_supply).trim()
      : null;

    const tax_type = payload.tax_type === "inter" ? "inter" : "intra";
    const cgst_amount = Number(payload.cgst_amount) || 0;
    const sgst_amount = Number(payload.sgst_amount) || 0;
    const igst_amount = Number(payload.igst_amount) || 0;

    if (!client_id || !invoice_number || !invoice_date) {
      return new Response(
        JSON.stringify({
          error:
            "Client, Invoice Number, and Invoice Date are mandatory fields.",
        }),
        { status: 400, headers: corsHeaders },
      );
    }
    if (items.length === 0) {
      return new Response(
        JSON.stringify({ error: "At least one billing item is required." }),
        { status: 400, headers: corsHeaders },
      );
    }

    if (invoice_number !== existingBill.invoice_number) {
      const duplicateBill = await env.DB.prepare(
        "SELECT id FROM billing WHERE warehouse_id = ? AND invoice_number = ? AND id != ?",
      )
        .bind(auth.context.warehouse_id, invoice_number, billingId)
        .first();
      if (duplicateBill) {
        return new Response(
          JSON.stringify({
            error: `Invoice Number '${invoice_number}' is already in use in this warehouse.`,
          }),
          { status: 409, headers: corsHeaders },
        );
      }
    }

    const existingMainItems = await env.DB.prepare(
      "SELECT id FROM billing_main_items WHERE billing_id = ?",
    )
      .bind(billingId)
      .all();
    const existingMainIds = (existingMainItems.results || []).map(
      (r) => r.id,
    );

    const batchStatements = [
      env.DB.prepare(
        `UPDATE billing SET
              client_id = ?, invoice_number = ?, invoice_date = ?, due_date = ?,
              billing_period_from = ?, billing_period_to = ?, reference_number = ?, reference_date = ?,
              buyers_order_no = ?, buyers_order_date = ?, dispatch_doc_no = ?, dispatch_through = ?,
              destination = ?, terms_of_delivery = ?, delivery_note = ?, delivery_note_date = ?,
              wh_company_name = ?, wh_gstin = ?, wh_address = ?, wh_state_name = ?, wh_state_code = ?,
              wh_fssai = ?, wh_bank_name = ?, wh_account_number = ?, wh_branch_ifsc = ?, wh_contact = ?, wh_email = ?,
              buyer_name = ?, buyer_gstin = ?, buyer_address = ?, buyer_state_name = ?, buyer_state_code = ?, place_of_supply = ?,
              tax_type = ?, subtotal = ?, cgst_amount = ?, sgst_amount = ?, igst_amount = ?, round_off = ?,
              discount = ?, other_charges = ?, grand_total = ?, notes = ?, other_ref = ?,
              updated_by_user_id = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?`,
      ).bind(
        client_id,
        invoice_number,
        invoice_date,
        due_date,
        billing_period_from,
        billing_period_to,
        reference_number,
        reference_date,
        buyers_order_no,
        buyers_order_date,
        dispatch_doc_no,
        dispatch_through,
        destination,
        terms_of_delivery,
        delivery_note,
        delivery_note_date,
        wh_company_name,
        wh_gstin,
        wh_address,
        wh_state_name,
        wh_state_code,
        wh_fssai,
        wh_bank_name,
        wh_account_number,
        wh_branch_ifsc,
        wh_contact,
        wh_email,
        buyer_name,
        buyer_gstin,
        buyer_address,
        buyer_state_name,
        buyer_state_code,
        place_of_supply,
        tax_type,
        subtotal,
        cgst_amount,
        sgst_amount,
        igst_amount,
        round_off,
        discount,
        other_charges,
        grand_total,
        notes,
        other_ref,
        auth.context.user_id,
        billingId,
      ),
    ];

    if (existingMainIds.length > 0) {
      const placeholders = existingMainIds.map(() => "?").join(",");
      batchStatements.push(
        env.DB.prepare(
          `DELETE FROM billing_sub_items WHERE main_item_id IN (${placeholders})`,
        ).bind(...existingMainIds),
      );
    }
    batchStatements.push(
      env.DB.prepare(
        "DELETE FROM billing_main_items WHERE billing_id = ?",
      ).bind(billingId),
    );

    items.forEach((item, idx) => {
      const mainItemId = "bmi_" + crypto.randomUUID();
      batchStatements.push(
        env.DB.prepare(
          `INSERT INTO billing_main_items (id, billing_id, main_description, hsn_sac, tax_rate, amount, sort_order)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          mainItemId,
          billingId,
          String(item.main_description || item.description || "").trim(),
          String(item.hsn_sac || "").trim(),
          Number(item.tax_rate) || 0,
          Number(item.amount) || 0,
          idx,
        ),
      );

      const subItems = Array.isArray(item.sub_items) ? item.sub_items : [];
      subItems.forEach((sub, subIdx) => {
        const subItemId = "bsi_" + crypto.randomUUID();
        batchStatements.push(
          env.DB.prepare(
            `INSERT INTO billing_sub_items (id, main_item_id, sub_description, quantity, unit, rate, amount, sort_order)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            subItemId,
            mainItemId,
            sub.sub_description ? String(sub.sub_description).trim() : null,
            sub.quantity !== undefined &&
              sub.quantity !== null &&
              sub.quantity !== ""
              ? Number(sub.quantity)
              : null,
            sub.unit ? String(sub.unit).trim() : null,
            sub.rate !== undefined && sub.rate !== null && sub.rate !== ""
              ? Number(sub.rate)
              : null,
            sub.amount !== undefined &&
              sub.amount !== null &&
              sub.amount !== ""
              ? Number(sub.amount)
              : null,
            subIdx,
          ),
        );
      });
    });

    await env.DB.batch(batchStatements);

    return new Response(
      JSON.stringify({
        success: true,
        message: "Bill updated successfully.",
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}

// -------------------------------------------------------------------------
// DELETE /api/billing/:id -> Delete a bill (only while status = 'pending')
// -------------------------------------------------------------------------
export async function deleteBillHandler(request, env, matchParams) {
  const auth = await getTenantContext(request, env);
  if (!auth.success) {
    return new Response(JSON.stringify({ error: auth.error }), {
      status: auth.status,
      headers: corsHeaders,
    });
  }
  if (auth.context.role !== "admin") {
    return new Response(
      JSON.stringify({
        error: "Operation Forbidden: Admin access required.",
      }),
      { status: 403, headers: corsHeaders },
    );
  }

  try {
    const billingId = matchParams[1];
    const existingBill = await env.DB.prepare(
      "SELECT id, status FROM billing WHERE id = ? AND warehouse_id = ?",
    )
      .bind(billingId, auth.context.warehouse_id)
      .first();

    if (!existingBill) {
      return new Response(JSON.stringify({ error: "Bill not found." }), {
        status: 404,
        headers: corsHeaders,
      });
    }
    if (existingBill.status === "paid") {
      return new Response(
        JSON.stringify({
          error: "This bill has been paid and can no longer be deleted.",
        }),
        { status: 403, headers: corsHeaders },
      );
    }

    // Clean up Cloudinary assets before the DB cascade removes the attachment rows
    const attachments = await env.DB.prepare(
      "SELECT cloudinary_public_id, cloudinary_resource_type FROM billing_attachments WHERE billing_id = ?",
    )
      .bind(billingId)
      .all();

    for (const att of attachments.results || []) {
      try {
        await destroyCloudinaryAsset(
          att.cloudinary_public_id,
          att.cloudinary_resource_type,
          env,
        );
      } catch (cloudErr) {
        // Don't block the delete on a Cloudinary hiccup — log and continue.
        console.error(
          "Cloudinary cleanup failed during bill delete:",
          cloudErr.message,
        );
      }
    }

    // billing_items and billing_attachments cascade via ON DELETE CASCADE
    await env.DB.prepare("DELETE FROM billing WHERE id = ?")
      .bind(billingId)
      .run();

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}
