// src/index.js

import * as XLSX from "xlsx";

// =========================================================================
// OPENING STOCK PARSING & VALIDATION ENGINE
// =========================================================================

const REQUIRED_EXCEL_HEADERS = [
  "Item Code",
  "Item Description",
  "Quantity",
  "UOM",
  "Category",
  "Location",
  "Batch Number",
  "Manufacturing Date",
  "Expiry Date",
];
const OPTIONAL_EXCEL_HEADERS = ["Case Conversion Qty"];

const VALID_CATEGORIES = ["ambient", "frozen", "chiller"];

function parseAndValidateExcel(arrayBuffer) {
  const errors = [];
  const warnings = [];

  let workbook;
  try {
    workbook = XLSX.read(new Uint8Array(arrayBuffer), {
      type: "array",
      cellDates: true,
    });
  } catch (err) {
    return {
      isValid: false,
      errors: ["Invalid Excel file format or corrupted file."],
      warnings: [],
      parsedRows: [],
    };
  }

  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    return {
      isValid: false,
      errors: ["Excel workbook contains no readable sheets."],
      warnings: [],
      parsedRows: [],
    };
  }

  const sheet = workbook.Sheets[sheetName];
  const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });

  if (!rawRows || rawRows.length < 2) {
    return {
      isValid: false,
      errors: [
        "Excel file must contain a header row and at least one data row.",
      ],
      warnings: [],
      parsedRows: [],
    };
  }

  // Header Validation
  const fileHeaders = rawRows[0].map((h) => String(h || "").trim());
  const headerMap = {};

  REQUIRED_EXCEL_HEADERS.forEach((reqHeader) => {
    const idx = fileHeaders.findIndex(
      (fh) => fh.toLowerCase() === reqHeader.toLowerCase(),
    );
    if (idx === -1) {
      errors.push(`Missing mandatory header column: "${reqHeader}"`);
    } else {
      headerMap[reqHeader] = idx;
    }
  });

  OPTIONAL_EXCEL_HEADERS.forEach((optHeader) => {
    const idx = fileHeaders.findIndex(
      (fh) => fh.toLowerCase() === optHeader.toLowerCase(),
    );
    if (idx !== -1) {
      headerMap[optHeader] = idx;
    }
  });

  if (errors.length > 0) {
    return { isValid: false, errors, warnings, parsedRows: [] };
  }

  // Row Data Validation
  const parsedRows = [];
  const duplicateTracker = new Set();

  for (let i = 1; i < rawRows.length; i++) {
    const row = rawRows[i];
    const excelRowNum = i + 1;

    // Check if entire row is empty
    const isEmptyRow = row.every((cell) => String(cell || "").trim() === "");
    if (isEmptyRow) continue;

    const itemCode = String(row[headerMap["Item Code"]] || "").trim();
    const itemDescription = String(
      row[headerMap["Item Description"]] || "",
    ).trim();
    const rawQuantity = row[headerMap["Quantity"]];
    const uom = String(row[headerMap["UOM"]] || "").trim();
    const category = String(row[headerMap["Category"]] || "").trim();
    const location = String(row[headerMap["Location"]] || "").trim();
    const batchNumber = String(row[headerMap["Batch Number"]] || "").trim();
    const rawMfgDate = row[headerMap["Manufacturing Date"]];
    const rawExpDate = row[headerMap["Expiry Date"]];
    const rawCaseConversionQty =
      headerMap["Case Conversion Qty"] !== undefined
        ? row[headerMap["Case Conversion Qty"]]
        : null;

    // Required Field Validations
    if (!itemCode) errors.push(`Row ${excelRowNum}: Item Code is mandatory.`);
    if (!itemDescription)
      errors.push(`Row ${excelRowNum}: Item Description is mandatory.`);
    if (!uom) errors.push(`Row ${excelRowNum}: UOM is mandatory.`);
    if (!location) errors.push(`Row ${excelRowNum}: Location is mandatory.`);

    // Quantity Validation
    const quantityNum = Number(rawQuantity);
    if (
      rawQuantity === "" ||
      rawQuantity === null ||
      isNaN(quantityNum) ||
      quantityNum <= 0
    ) {
      errors.push(
        `Row ${excelRowNum}: Quantity must be a valid numeric value greater than 0.`,
      );
    }

    // Category Validation (Case-insensitive)
    if (!category || !VALID_CATEGORIES.includes(category.toLowerCase())) {
      errors.push(
        `Row ${excelRowNum}: Category "${category}" is invalid. Allowed values: Ambient, Frozen, Chiller.`,
      );
    }

    // Date Validations
    const mfgDate = parseExcelDate(rawMfgDate);
    if (rawMfgDate && mfgDate === "INVALID") {
      errors.push(
        `Row ${excelRowNum}: Manufacturing Date "${rawMfgDate}" is not a valid date.`,
      );
    }

    const expDate = parseExcelDate(rawExpDate);
    if (rawExpDate && expDate === "INVALID") {
      errors.push(
        `Row ${excelRowNum}: Expiry Date "${rawExpDate}" is not a valid date.`,
      );
    }

    let caseConversionQty = null;
    if (
      rawCaseConversionQty !== null &&
      rawCaseConversionQty !== undefined &&
      String(rawCaseConversionQty).trim() !== ""
    ) {
      const parsedCaseQty = Number(rawCaseConversionQty);
      if (isNaN(parsedCaseQty) || parsedCaseQty <= 0) {
        errors.push(
          `Row ${excelRowNum}: Case Conversion Qty must be a valid positive number when provided.`,
        );
      } else {
        caseConversionQty = parsedCaseQty;
      }
    }

    if (mfgDate && expDate && mfgDate !== "INVALID" && expDate !== "INVALID") {
      if (new Date(expDate) < new Date(mfgDate)) {
        errors.push(
          `Row ${excelRowNum}: Expiry Date (${expDate}) cannot be earlier than Manufacturing Date (${mfgDate}).`,
        );
      }
    }

    // Duplicate Validation Warning
    const dupKey = `${itemCode.toLowerCase()}|${batchNumber.toLowerCase()}|${location.toUpperCase()}`;
    if (duplicateTracker.has(dupKey)) {
      warnings.push(
        `Row ${excelRowNum}: Duplicate item detected for Item Code "${itemCode}", Batch "${batchNumber || "N/A"}", and Location "${location.toUpperCase()}".`,
      );
    } else {
      duplicateTracker.add(dupKey);
    }

    parsedRows.push({
      item_code: itemCode,
      item_description: itemDescription,
      quantity: quantityNum,
      uom: uom,
      category: normalizeCategory(category),
      location: location.toUpperCase(),
      batch_number: batchNumber || null,
      manufacturing_date: mfgDate === "INVALID" ? null : mfgDate,
      expiry_date: expDate === "INVALID" ? null : expDate,
      case_conversion_qty: caseConversionQty,
    });
  }

  if (parsedRows.length === 0 && errors.length === 0) {
    errors.push("Excel file contains no data rows.");
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
    totalRows: parsedRows.length,
    parsedRows,
  };
}

function parseExcelDate(val) {
  if (val === null || val === undefined || val === "") return null;
  if (val instanceof Date) {
    return isNaN(val.getTime()) ? "INVALID" : val.toISOString().split("T")[0];
  }
  if (typeof val === "number") {
    const parsed = XLSX.SSF.parse_date_code(val);
    if (parsed) {
      const y = parsed.y;
      const m = String(parsed.m).padStart(2, "0");
      const d = String(parsed.d).padStart(2, "0");
      return `${y}-${m}-${d}`;
    }
  }
  const str = String(val).trim();
  const dateObj = new Date(str);
  return isNaN(dateObj.getTime())
    ? "INVALID"
    : dateObj.toISOString().split("T")[0];
}

function normalizeCategory(cat) {
  const lower = String(cat).toLowerCase();
  if (lower === "frozen") return "Frozen";
  if (lower === "chiller") return "Chiller";
  return "Ambient";
}

// =========================================================================
// 1. BASE64URL HELPERS (Required for standard JWT specifications)
// =========================================================================
function base64urlEncode(str) {
  const base64 = btoa(unescape(encodeURIComponent(str)));
  return base64.replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function base64urlDecode(str) {
  let base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4) base64 += "=";
  return decodeURIComponent(escape(atob(base64)));
}

// =========================================================================
// 2. JWT SIGNING AND VERIFICATION
// =========================================================================
async function signJWT(payload, secret) {
  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = base64urlEncode(JSON.stringify(header));
  const encodedPayload = base64urlEncode(JSON.stringify(payload));
  const dataToSign = `${encodedHeader}.${encodedPayload}`;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signatureBuffer = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(dataToSign),
  );

  const signatureArray = Array.from(new Uint8Array(signatureBuffer));
  const signatureStr = String.fromCharCode(...signatureArray);
  const encodedSignature = base64urlEncode(signatureStr);

  return `${dataToSign}.${encodedSignature}`;
}

async function verifyJWT(token, secret) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const dataToVerify = `${encodedHeader}.${encodedPayload}`;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );

  // Decode signature back into binary bytes
  const sigStr = base64urlDecode(encodedSignature);
  const sigBuffer = new Uint8Array(sigStr.length);
  for (let i = 0; i < sigStr.length; i++) {
    sigBuffer[i] = sigStr.charCodeAt(i);
  }

  const isValid = await crypto.subtle.verify(
    "HMAC",
    key,
    sigBuffer,
    encoder.encode(dataToVerify),
  );

  if (!isValid) return null;

  const payload = JSON.parse(base64urlDecode(encodedPayload));

  // Real-time expiration guard: Check if token has run past its lifetime
  if (payload.exp && Date.now() >= payload.exp) return null;

  return payload;
}

// =========================================================================
// 3. SECURE PASSWORD HASHING & VERIFICATION (SHA-256 with Random Salt)
// =========================================================================
async function hashPassword(password) {
  const encoder = new TextEncoder();

  // Generate a random 16-byte salt unique to this user
  const saltBytes = new Uint8Array(16);
  crypto.getRandomValues(saltBytes);
  const saltHex = Array.from(saltBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Combine salt + password and compute the digest hash
  const combinedData = encoder.encode(saltHex + password);
  const hashBuffer = await crypto.subtle.digest("SHA-256", combinedData);
  const hashHex = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Save both the salt and hash together separated by a colon
  return `${saltHex}:${hashHex}`;
}

async function verifyPassword(password, storedHash) {
  const parts = storedHash.split(":");
  if (parts.length !== 2) return false;

  const [saltHex, originalHashHex] = parts;
  const encoder = new TextEncoder();

  // Re-hash the incoming attempt with the user's original unique salt
  const combinedData = encoder.encode(saltHex + password);
  const checkBuffer = await crypto.subtle.digest("SHA-256", combinedData);
  const checkHashHex = Array.from(new Uint8Array(checkBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return checkHashHex === originalHashHex;
}

// =========================================================================
// SNIPPET 2: REAL-TIME TENANT AUTHENTICATION MIDDLEWARE
// =========================================================================
async function getTenantContext(request, env) {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return {
      success: false,
      error: "Authorization header missing or malformed.",
      status: 401,
    };
  }

  // Extract the raw token string
  const token = authHeader.substring(7);
  const payload = await verifyJWT(token, env.JWT_SECRET);

  if (!payload) {
    return {
      success: false,
      error: "Invalid or expired authentication token.",
      status: 401,
    };
  }

  try {
    // Real-time lookup to enforce live user suspension and tenant subscription status
    // Changed to LEFT JOIN so the Super Admin (who has no warehouse_id) isn't filtered out
    const liveUser = await env.DB.prepare(
      `
      SELECT u.id, u.warehouse_id, u.role, u.is_active, w.subscription_status
      FROM users u
      LEFT JOIN warehouses w ON u.warehouse_id = w.id
      WHERE u.id = ?
    `,
    )
      .bind(payload.user_id)
      .first();

    if (!liveUser) {
      return {
        success: false,
        error: "User profile no longer exists.",
        status: 401,
      };
    }

    // NEW BOOTSTRAP GATE: If the user is the platform Super Admin, bypass tenant billing gates
    if (liveUser.role === "super_admin") {
      return {
        success: true,
        context: {
          user_id: liveUser.id,
          warehouse_id: liveUser.warehouse_id, // Super admin is global
          role: liveUser.role,
        },
      };
    }

    // Standard Tenant Gateways (Only applied to Warehouse Admins and Operators)
    if (Number(liveUser.is_active) === 0) {
      return {
        success: false,
        error: "Your user profile has been suspended.",
        status: 403,
      };
    }

    if (liveUser.subscription_status === "suspended") {
      return {
        success: false,
        error: "This warehouse subscription is suspended.",
        status: 403,
      };
    }

    // Tenant context is fully validated. Return authorization data to the router.
    return {
      success: true,
      context: {
        user_id: liveUser.id,
        warehouse_id: liveUser.warehouse_id,
        role: liveUser.role,
      },
    };
  } catch (dbError) {
    return {
      success: false,
      error: `Security verification database error: ${dbError.message}`,
      status: 500,
    };
  }
}

// 1. Cloudinary helper remains unchanged (it's functionally perfect for Web Crypto)
async function generateCloudinarySignature(publicId, timestamp, apiSecret) {
  const text = `public_id=${publicId}&timestamp=${timestamp}${apiSecret}`;
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-1", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// 1b. Cloudinary asset deletion — used by Billing attachment cleanup. Reuses
// generateCloudinarySignature() since /destroy's signed params (public_id +
// timestamp) are identical in shape to /upload's.
async function destroyCloudinaryAsset(publicId, resourceType, env) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = await generateCloudinarySignature(
    publicId,
    timestamp,
    env.CLOUDINARY_API_SECRET,
  );

  const destroyFormData = new FormData();
  destroyFormData.append("public_id", publicId);
  destroyFormData.append("timestamp", timestamp);
  destroyFormData.append("api_key", env.CLOUDINARY_API_KEY);
  destroyFormData.append("signature", signature);

  const resp = await fetch(
    `https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/${resourceType || "raw"}/destroy`,
    { method: "POST", body: destroyFormData },
  );
  const result = await resp.json();
  if (
    !resp.ok ||
    (result.result && result.result !== "ok" && result.result !== "not found")
  ) {
    throw new Error(result.error?.message || "Cloudinary destroy failed");
  }
  return result;
}

// 2. Comprehensive CORS headers
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

export default {
  async fetch(request, env, ctx) {
    // Handle Preflight OPTIONS requests immediately
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);

    // =========================================================================
    // NEW SNIPPET: PLATFORM SUPER-ADMIN CONTROL PLANE ENDPOINTS
    // =========================================================================

    // -------------------------------------------------------------------------
    // 1. ENDPOINT: Onboard New Warehouse Tenant & Admin (POST /api/super/warehouses)
    // -------------------------------------------------------------------------
    if (
      request.method === "POST" &&
      (url.pathname === "/api/super/warehouses" ||
        url.pathname === "/api/superadmin/warehouses")
    ) {
      const auth = await getTenantContext(request, env);
      if (!auth.success || auth.context.role !== "super_admin") {
        return new Response(
          JSON.stringify({ error: "Forbidden: Super Admin access required." }),
          {
            status: 403,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      try {
        const {
          company_name,
          initial_status,
          admin_username,
          admin_password,
          gstin,
          address,
        } = await request.json();

        // Validate inputs (status can be 'active' or 'trial')
        if (!company_name || !admin_username || !admin_password) {
          return new Response(
            JSON.stringify({
              error: "Missing required onboarding parameters.",
            }),
            {
              status: 400,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }

        const warehouseId = "wh_" + crypto.randomUUID();
        const adminUserId = "usr_" + crypto.randomUUID();

        // FIXED: Changed adminPassword to admin_password to match the destructured variable above
        const adminPasswordHash = await hashPassword(admin_password);
        const subscriptionMode = initial_status || "trial";
        const gstinValue = gstin ? String(gstin).trim().toUpperCase() : null;
        const addressValue = address ? String(address).trim() : null;

        // Batch statement ensures BOTH the warehouse entry and its master account insert together perfectly
        await env.DB.batch([
          env.DB.prepare(
            `
            INSERT INTO warehouses (id, company_name, gstin, address, subscription_status)
            VALUES (?, ?, ?, ?, ?)
          `,
          ).bind(
            warehouseId,
            company_name,
            gstinValue,
            addressValue,
            subscriptionMode,
          ),

          env.DB.prepare(
            `
            INSERT INTO users (id, warehouse_id, username, password_hash, role, is_active)
            VALUES (?, ?, ?, ?, 'admin', 1)
          `,
          ).bind(adminUserId, warehouseId, admin_username, adminPasswordHash),
        ]);

        return new Response(
          JSON.stringify({
            message:
              "New warehouse tenant and administrator provisioned successfully.",
            warehouse_id: warehouseId,
            admin_user_id: adminUserId,
          }),
          {
            status: 201,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      } catch (error) {
        if (error.message.includes("UNIQUE constraint failed")) {
          return new Response(
            JSON.stringify({
              error: "The provided admin username is already registered.",
            }),
            {
              status: 409,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }
        return new Response(
          JSON.stringify({
            error: `Onboarding execution error: ${error.message}`,
          }),
          {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }
    }

    // -------------------------------------------------------------------------
    // 2. ENDPOINT: Toggle Warehouse Subscription State (POST /api/super/warehouses/subscription)
    // -------------------------------------------------------------------------
    if (
      request.method === "POST" &&
      (url.pathname === "/api/super/warehouses/subscription" ||
        url.pathname === "/api/superadmin/warehouses/subscription")
    ) {
      const auth = await getTenantContext(request, env);
      if (!auth.success || auth.context.role !== "super_admin") {
        return new Response(
          JSON.stringify({ error: "Forbidden: Super Admin access required." }),
          {
            status: 403,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      try {
        const { target_warehouse_id, set_status } = await request.json(); // set_status can be: 'active', 'suspended', 'trial'

        const validStatuses = ["active", "suspended", "trial"];
        if (!target_warehouse_id || !validStatuses.includes(set_status)) {
          return new Response(
            JSON.stringify({
              error:
                "Invalid target parameters or unknown subscription status string.",
            }),
            {
              status: 400,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }

        const result = await env.DB.prepare(
          `
      UPDATE warehouses
      SET subscription_status = ?
      WHERE id = ?
    `,
        )
          .bind(set_status, target_warehouse_id)
          .run();

        if (result.meta.changes === 0) {
          return new Response(
            JSON.stringify({ error: "Warehouse target profile not found." }),
            {
              status: 404,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }

        return new Response(
          JSON.stringify({
            message: `Warehouse subscription state updated to '${set_status}' successfully.`,
          }),
          {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      } catch (error) {
        return new Response(
          JSON.stringify({
            error: `Subscription mutation failure: ${error.message}`,
          }),
          {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }
    }

    // -------------------------------------------------------------------------
    // 3. ENDPOINT: Fetch All Warehouses Directory (GET /api/superadmin/warehouses)
    // -------------------------------------------------------------------------
    if (
      request.method === "GET" &&
      (url.pathname === "/api/super/warehouses" ||
        url.pathname === "/api/superadmin/warehouses")
    ) {
      const auth = await getTenantContext(request, env);
      if (!auth.success || auth.context.role !== "super_admin") {
        return new Response(
          JSON.stringify({ error: "Forbidden: Super Admin access required." }),
          {
            status: 403,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      try {
        // Query the D1 database for all registered tenant structures
        const rows = await env.DB.prepare(
          `SELECT id, company_name, gstin, address, subscription_status, created_at FROM warehouses ORDER BY created_at DESC`,
        ).all();

        // Cloudflare D1 returns rows under the '.results' array property
        return new Response(JSON.stringify(rows.results || []), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } catch (error) {
        return new Response(
          JSON.stringify({
            error: `Failed to retrieve warehouses: ${error.message}`,
          }),
          {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }
    }

    // =========================================================================
    // SNIPPET 3: AUTHENTICATION AND MANAGEMENT API ENDPOINTS
    // =========================================================================

    // -------------------------------------------------------------------------
    // 1. ENDPOINT: User Login (POST /api/auth/login) - UNPROTECTED
    // -------------------------------------------------------------------------
    if (request.method === "POST" && url.pathname === "/api/auth/login") {
      try {
        const { username, password } = await request.json();

        if (!username || !password) {
          return new Response(
            JSON.stringify({ error: "Username and password are required." }),
            {
              status: 400,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }

        // LOOKUP UPDATE: Added w.company_name, w.gstin, w.address (used on billing invoices) to extract the warehouse profile
        const userRow = await env.DB.prepare(
          `
          SELECT u.id, u.username, u.password_hash, u.role, u.is_active, u.warehouse_id, w.subscription_status, w.company_name, w.gstin, w.address
          FROM users u
          LEFT JOIN warehouses w ON u.warehouse_id = w.id
          WHERE u.username = ?
        `,
        )
          .bind(username)
          .first();

        if (!userRow) {
          return new Response(
            JSON.stringify({ error: "Invalid username or password." }),
            {
              status: 401,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }

        const isPasswordValid = await verifyPassword(
          password,
          userRow.password_hash,
        );
        if (!isPasswordValid) {
          return new Response(
            JSON.stringify({ error: "Invalid username or password." }),
            {
              status: 401,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }

        // Enforce operational lifecycle gates ONLY if the logging user is NOT the platform Super Admin
        if (userRow.role !== "super_admin") {
          if (Number(userRow.is_active) === 0) {
            return new Response(
              JSON.stringify({ error: "Your profile has been suspended." }),
              {
                status: 403,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
              },
            );
          }

          if (userRow.subscription_status === "suspended") {
            return new Response(
              JSON.stringify({
                error: "This warehouse subscription is suspended.",
              }),
              {
                status: 403,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
              },
            );
          }
        }

        // Construct the JWT token payload (Expires in 24 Hours)
        const expirationTime = Date.now() + 24 * 60 * 60 * 1000;
        const tokenPayload = {
          user_id: userRow.id,
          username: userRow.username,
          warehouse_id: userRow.warehouse_id,
          role: userRow.role,
          exp: expirationTime,
        };

        const token = await signJWT(tokenPayload, env.JWT_SECRET);

        // RESPONSE UPDATE: Added company_name inside the returned user object
        return new Response(
          JSON.stringify({
            message: "Login successful.",
            token,
            user: {
              id: userRow.id,
              username: userRow.username,
              role: userRow.role,
              warehouse_id: userRow.warehouse_id,
              company_name: userRow.company_name, // Handed down cleanly to app.js local storage
              gstin: userRow.gstin, // Warehouse GSTIN, used when generating billing invoices client-side
              address: userRow.address, // Warehouse address, used when generating billing invoices client-side
            },
          }),
          {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      } catch (error) {
        return new Response(
          JSON.stringify({ error: `Login pipeline failure: ${error.message}` }),
          {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }
    }

    // -------------------------------------------------------------------------
    // 2. ENDPOINT: Add New User Account (POST /api/auth/register-operator) - PROTECTED
    // -------------------------------------------------------------------------
    if (
      request.method === "POST" &&
      url.pathname === "/api/auth/register-operator"
    ) {
      const auth = await getTenantContext(request, env);
      if (!auth.success) {
        return new Response(JSON.stringify({ error: auth.error }), {
          status: auth.status,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Access Control: Only the Tenant Warehouse Admin can spawn sub-accounts
      if (auth.context.role !== "admin") {
        return new Response(
          JSON.stringify({
            error: "Forbidden: Only Warehouse Admins can create users.",
          }),
          {
            status: 403,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      try {
        // Parse incoming request parameters dynamically from the front-end form layout
        const { username, password, role } = await request.json();
        if (!username || !password) {
          return new Response(
            JSON.stringify({
              error: "Missing required username or password fields.",
            }),
            {
              status: 400,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }

        // Fall back safely to "operator" status if no explicit selection role string was supplied
        const assignedRole = role || "operator";

        const secureHash = await hashPassword(password);
        const newUserId = crypto.randomUUID();

        // Save dynamic assignedRole parameter to your D1 Database row instead of hardcoded 'operator'
        await env.DB.prepare(
          `
          INSERT INTO users (id, warehouse_id, username, password_hash, role, is_active)
          VALUES (?, ?, ?, ?, ?, 1)
        `,
        )
          .bind(
            newUserId,
            auth.context.warehouse_id,
            username,
            secureHash,
            assignedRole,
          )
          .run();

        return new Response(
          JSON.stringify({
            message: `User account '${username}' with role '${assignedRole}' successfully activated.`,
          }),
          {
            status: 201,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      } catch (error) {
        if (error.message.includes("UNIQUE constraint failed")) {
          return new Response(
            JSON.stringify({
              error: "Username already exists on the platform registry.",
            }),
            {
              status: 409,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }
        return new Response(
          JSON.stringify({ error: `Registration error: ${error.message}` }),
          {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }
    }

    // -------------------------------------------------------------------------
    // 3. ENDPOINT: Toggle Operator Status (POST /api/auth/toggle-user-status) - PROTECTED
    // -------------------------------------------------------------------------
    if (
      request.method === "POST" &&
      url.pathname === "/api/auth/toggle-user-status"
    ) {
      const auth = await getTenantContext(request, env);
      if (!auth.success) {
        return new Response(JSON.stringify({ error: auth.error }), {
          status: auth.status,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (auth.context.role !== "admin") {
        return new Response(
          JSON.stringify({ error: "Forbidden: Unauthorized access." }),
          {
            status: 403,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      try {
        const { target_user_id, set_active } = await request.json(); // set_active will be 1 or 0

        if (!target_user_id || (set_active !== 0 && set_active !== 1)) {
          return new Response(
            JSON.stringify({
              error: "Invalid target parameters or status assignment integers.",
            }),
            {
              status: 400,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }

        // Target the update. Note the 'warehouse_id = ?' clause — this prevents
        // an admin from accessing or editing a user row belonging to another tenant warehouse.
        const result = await env.DB.prepare(
          `
          UPDATE users 
          SET is_active = ? 
          WHERE id = ? AND warehouse_id = ?
        `,
        )
          .bind(set_active, target_user_id, auth.context.warehouse_id)
          .run();

        if (result.meta.changes === 0) {
          return new Response(
            JSON.stringify({
              error:
                "User account profile not found within your authorized tenant scope.",
            }),
            {
              status: 404,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }

        return new Response(
          JSON.stringify({
            message: `User profile operational state modified successfully to: ${set_active}.`,
          }),
          {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      } catch (error) {
        return new Response(
          JSON.stringify({
            error: `Lifecycle status change failed: ${error.message}`,
          }),
          {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }
    }

    // -------------------------------------------------------------------------
    // 4. ENDPOINT: Fetch All Tenant Users (GET /api/users) - PROTECTED
    // -------------------------------------------------------------------------
    if (request.method === "GET" && url.pathname === "/api/users") {
      const auth = await getTenantContext(request, env);
      if (!auth.success) {
        return new Response(JSON.stringify({ error: auth.error }), {
          status: auth.status,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Access Control: Only the Tenant Warehouse Admin can view the workforce directory
      if (auth.context.role !== "admin") {
        return new Response(
          JSON.stringify({
            error: "Forbidden: Access restricted to Warehouse Admins.",
          }),
          {
            status: 403,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      try {
        // Multi-tenant check: Fetch users that belong exclusively to this admin's warehouse_id
        const rows = await env.DB.prepare(
          `
          SELECT id, username, role, is_active 
          FROM users 
          WHERE warehouse_id = ? 
          ORDER BY username ASC
          `,
        )
          .bind(auth.context.warehouse_id)
          .all();

        // Return the results array wrapped perfectly for the frontend table matrix
        return new Response(JSON.stringify(rows.results || []), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } catch (error) {
        return new Response(
          JSON.stringify({
            error: `Failed to retrieve user accounts: ${error.message}`,
          }),
          {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }
    }

    // =========================================================================
    // ENDPOINT 1: Fetch Staged Shipment Data for verification UI (SECURED)
    // =========================================================================
    if (request.method === "GET" && url.pathname === "/api/shipments/staged") {
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
    // ENDPOINT 2: Query if Party GSTIN already exists inside Master Data (SECURED)
    // =========================================================================
    if (request.method === "GET" && url.pathname === "/api/parties/lookup") {
      const auth = await getTenantContext(request, env);
      if (!auth.success) {
        return new Response(JSON.stringify({ error: auth.error }), {
          status: auth.status,
          headers: corsHeaders,
        });
      }

      const gstin = url.searchParams.get("gstin")?.trim().toUpperCase();

      if (!gstin || gstin.length !== 15) {
        return new Response(
          JSON.stringify({
            found: false,
            party: null,
            error: "GSTIN must be exactly 15 characters.",
          }),
          { status: 400, headers: corsHeaders },
        );
      }

      // Isolation: Look up party bound by tenant warehouse context
      const matchedParty = await env.DB.prepare(
        `
    SELECT id, name, gstin, address 
    FROM parties 
    WHERE gstin = ? AND (? = 'super_admin' OR warehouse_id = ?)
  `,
      )
        .bind(gstin, auth.context.role, auth.context.warehouse_id)
        .first();

      return new Response(
        JSON.stringify({ found: !!matchedParty, party: matchedParty || null }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // =========================================================================
    // ENDPOINT 3: Inbound Upload Endpoint (SECURED WITH CONTEXT)
    // =========================================================================
    if (request.method === "POST" && url.pathname === "/api/inbound/upload") {
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
    // ENDPOINT: Outbound AI Upload — mirrors /api/inbound/upload exactly, but
    // stages into outbound_shipments and tags document_pages as 'outbound' so
    // the shared OCR/LLM pipeline can dispatch the right prompt + aggregator.
    // =========================================================================
    if (request.method === "POST" && url.pathname === "/api/outbound/upload") {
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
          "INSERT INTO outbound_shipments (id, status, warehouse_id, uploaded_by_user_id) VALUES (?, 'processing', ?, ?)",
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
            "INSERT INTO document_pages (id, shipment_id, shipment_type, image_url, document_type, ocr_status) VALUES (?, ?, 'outbound', ?, ?, 'queued')",
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

    if (request.method === "POST" && url.pathname === "/api/ocr/webhook") {
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
    // =========================================================================
    if (request.method === "POST" && url.pathname === "/api/shipments/commit") {
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
          ).bind(
            putawayTaskId,
            auth.context.warehouse_id,
            shipmentId,
            client_id,
          ),
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

    if (request.method === "GET" && url.pathname === "/api/shipments/pending") {
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

    // =========================================================================
    // ENDPOINT: Get Locations with Dynamic Status
    // =========================================================================
    if (request.method === "GET" && url.pathname === "/api/locations") {
      const auth = await getTenantContext(request, env);
      if (!auth.success) {
        return new Response(JSON.stringify({ error: auth.error }), {
          status: auth.status,
          headers: corsHeaders,
        });
      }

      if (auth.context.role === "super_admin") {
        return new Response(JSON.stringify({ error: "Access Denied" }), {
          status: 403,
          headers: corsHeaders,
        });
      }

      try {
        const specificLocationId = url.searchParams.get("id");

        if (specificLocationId) {
          const contents = await env.DB.prepare(
            `SELECT item_code, item_description, quantity 
             FROM inventory 
             WHERE warehouse_id = ? AND location_id = ? AND quantity > 0`,
          )
            .bind(auth.context.warehouse_id, specificLocationId)
            .all();

          return new Response(
            JSON.stringify({
              location_id: specificLocationId,
              items: contents.results,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json", ...corsHeaders },
            },
          );
        }

        // Optimized Query: Calculates 'Free' or 'Occupied' on-the-fly
        const query = `
          SELECT l.id, l.status,
            CASE 
              WHEN l.status = 'unavailable' THEN 'Unavailable'
              WHEN EXISTS (
                SELECT 1 FROM inventory i 
                WHERE i.warehouse_id = l.warehouse_id 
                  AND i.location_id = l.id 
                  AND i.quantity > 0
              ) THEN 'Occupied'
              ELSE 'Free'
            END as calculated_status
          FROM locations l
          WHERE l.warehouse_id = ?
          ORDER BY l.id ASC
        `;

        const list = await env.DB.prepare(query)
          .bind(auth.context.warehouse_id)
          .all();

        return new Response(JSON.stringify({ locations: list.results }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
    }

    // =========================================================================
    // ENDPOINT: Toggle Location Status (Admin Only)
    // =========================================================================
    if (
      request.method === "POST" &&
      url.pathname === "/api/locations/toggle-status"
    ) {
      const auth = await getTenantContext(request, env);
      if (!auth.success)
        return new Response(JSON.stringify({ error: auth.error }), {
          status: auth.status,
          headers: corsHeaders,
        });

      if (auth.context.role !== "admin") {
        return new Response(
          JSON.stringify({ error: "Forbidden: Admin access required." }),
          { status: 403, headers: corsHeaders },
        );
      }

      try {
        const { locationId, newStatus } = await request.json();

        await env.DB.prepare(
          "UPDATE locations SET status = ? WHERE id = ? AND warehouse_id = ?",
        )
          .bind(newStatus, locationId, auth.context.warehouse_id)
          .run();

        return new Response(
          JSON.stringify({ success: true, message: "Status updated." }),
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

    // =========================================================================
    // ENDPOINT: Create New Storage Location (ROLE GATED: ADMIN ONLY)
    // =========================================================================
    if (request.method === "POST" && url.pathname === "/api/locations") {
      const auth = await getTenantContext(request, env);
      if (!auth.success) {
        return new Response(JSON.stringify({ error: auth.error }), {
          status: auth.status,
          headers: corsHeaders,
        });
      }

      // STRICT ROLE GATE: Only the tenant master 'admin' can append the structural layout
      if (auth.context.role !== "admin") {
        return new Response(
          JSON.stringify({
            error: "Forbidden: Only Warehouse Admins can create new locations.",
          }),
          { status: 403, headers: corsHeaders },
        );
      }

      try {
        const payload = await request.json();
        const locationId = String(payload.locationId || "")
          .trim()
          .toUpperCase();

        if (!locationId || locationId.length < 2) {
          return new Response(
            JSON.stringify({
              error:
                "Invalid input: Location Identifier naming label is required.",
            }),
            { status: 400, headers: corsHeaders },
          );
        }

        // Check if this location text identifier already exists inside this warehouse
        const existing = await env.DB.prepare(
          "SELECT id FROM locations WHERE id = ? AND warehouse_id = ?",
        )
          .bind(locationId, auth.context.warehouse_id)
          .first();

        if (existing) {
          return new Response(
            JSON.stringify({
              error:
                "Conflict: This location label already exists in your warehouse setup.",
            }),
            { status: 409, headers: corsHeaders },
          );
        }

        // Insert into the locations index
        await env.DB.prepare(
          "INSERT INTO locations (id, warehouse_id, status) VALUES (?, ?, 'available')",
        )
          .bind(locationId, auth.context.warehouse_id)
          .run();

        return new Response(
          JSON.stringify({
            success: true,
            message: `Location '${locationId}' successfully initialized.`,
          }),
          {
            status: 201,
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
    // GET /api/putaway/pending
    // =========================================================================
    if (request.method === "GET" && url.pathname === "/api/putaway/pending") {
      const auth = await getTenantContext(request, env);
      if (!auth.success) {
        return new Response(JSON.stringify({ error: auth.error }), {
          status: auth.status,
          headers: corsHeaders,
        });
      }

      if (auth.context.role === "super_admin") {
        return new Response(JSON.stringify({ error: "Access Denied" }), {
          status: 403,
          headers: corsHeaders,
        });
      }

      try {
        const tasksQuery = await env.DB.prepare(
          `SELECT t.id, t.shipment_id, t.created_at, d.invoice_number, c.code AS client_code, c.name AS client_name, u.username AS verified_by
       FROM putaway_tasks t
       LEFT JOIN shipment_details d ON t.shipment_id = d.id
       LEFT JOIN clients c ON d.client_id = c.id
       LEFT JOIN users u ON d.verified_by_user_id = u.id
       WHERE t.warehouse_id = ? AND t.status = 'pending'
       ORDER BY t.created_at DESC`,
        )
          .bind(auth.context.warehouse_id)
          .all();

        const pendingTasks = tasksQuery.results;

        if (pendingTasks.length === 0) {
          return new Response(JSON.stringify({ tasks: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        }

        const taskIds = pendingTasks.map((t) => t.id);
        const placeholders = taskIds.map(() => "?").join(",");

        const itemsQuery = await env.DB.prepare(
          `SELECT putaway_task_id, id, item_code, item_description, quantity_to_place, category, manufacturing_date, expiry_date, batch_number, shipment_line_item_id, uom
       FROM putaway_task_items 
       WHERE putaway_task_id IN (${placeholders})`,
        )
          .bind(...taskIds)
          .all();

        const allItems = itemsQuery.results;

        const responseData = pendingTasks.map((task) => {
          return {
            ...task,
            items: allItems.filter((item) => item.putaway_task_id === task.id),
          };
        });

        return new Response(JSON.stringify({ tasks: responseData }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
    }

    // =========================================================================
    // GET /api/putaway/completed
    // =========================================================================
    if (request.method === "GET" && url.pathname === "/api/putaway/completed") {
      const auth = await getTenantContext(request, env);
      if (!auth.success) {
        return new Response(JSON.stringify({ error: auth.error }), {
          status: auth.status,
          headers: corsHeaders,
        });
      }

      if (auth.context.role === "super_admin") {
        return new Response(JSON.stringify({ error: "Access Denied" }), {
          status: 403,
          headers: corsHeaders,
        });
      }

      try {
        // Joined clients table to fetch client_code and client_name
        const tasksQuery = await env.DB.prepare(
          `SELECT t.id, t.shipment_id, t.created_at, d.invoice_number, c.code AS client_code, c.name AS client_name,
                  u1.username AS verified_by, u2.username AS completed_by, tx.completed_at AS completed_date_time
           FROM putaway_tasks t
           LEFT JOIN shipment_details d ON t.shipment_id = d.id
           LEFT JOIN clients c ON d.client_id = c.id
           LEFT JOIN users u1 ON d.verified_by_user_id = u1.id
           LEFT JOIN users u2 ON t.completed_by_user_id = u2.id
           LEFT JOIN transactions tx ON tx.transaction_type = 'inbound' AND tx.reference_id = t.shipment_id AND tx.warehouse_id = t.warehouse_id
           WHERE t.warehouse_id = ? AND t.status = 'completed'
           ORDER BY tx.completed_at DESC`,
        )
          .bind(auth.context.warehouse_id)
          .all();

        const completedTasks = tasksQuery.results;

        if (completedTasks.length === 0) {
          return new Response(JSON.stringify({ tasks: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        }

        const taskIds = completedTasks.map((t) => t.id);
        const placeholders = taskIds.map(() => "?").join(",");

        // UPDATED: Included batch_number in SELECT clause
        const itemsQuery = await env.DB.prepare(
          `SELECT putaway_task_id, id, item_code, item_description, quantity_to_place, category, manufacturing_date, expiry_date, batch_number, shipment_line_item_id, uom
           FROM putaway_task_items 
           WHERE putaway_task_id IN (${placeholders})`,
        )
          .bind(...taskIds)
          .all();

        const allItems = itemsQuery.results;
        const itemIds = allItems.map((i) => i.id);

        let allAllocations = [];
        if (itemIds.length > 0) {
          const itemPlaceholders = itemIds.map(() => "?").join(",");
          const allocQuery = await env.DB.prepare(
            `SELECT putaway_task_item_id, location_id, quantity 
             FROM putaway_task_item_allocations 
             WHERE putaway_task_item_id IN (${itemPlaceholders})`,
          )
            .bind(...itemIds)
            .all();
          allAllocations = allocQuery.results;
        }

        const responseData = completedTasks.map((task) => {
          const taskItems = allItems
            .filter((item) => item.putaway_task_id === task.id)
            .map((item) => {
              return {
                ...item,
                allocations: allAllocations
                  .filter((a) => a.putaway_task_item_id === item.id)
                  .map((a) => ({
                    location_id: a.location_id,
                    quantity: a.quantity,
                  })),
              };
            });
          return {
            ...task,
            items: taskItems,
          };
        });

        return new Response(JSON.stringify({ tasks: responseData }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
    }

    // =========================================================================
    // ENDPOINT: Complete Putaway Task with Dynamic Split Allocations (SECURED)
    // =========================================================================
    if (request.method === "POST" && url.pathname === "/api/putaway/complete") {
      const auth = await getTenantContext(request, env);
      if (!auth.success) {
        return new Response(JSON.stringify({ error: auth.error }), {
          status: auth.status,
          headers: corsHeaders,
        });
      }

      if (auth.context.role === "viewer") {
        return new Response(
          JSON.stringify({
            error:
              "Operation Forbidden: Viewers cannot register physical warehouse stock actions.",
          }),
          { status: 403, headers: corsHeaders },
        );
      }

      try {
        const payload = await request.json();
        const { putaway_task_id, allocations } = payload;

        if (
          !putaway_task_id ||
          !Array.isArray(allocations) ||
          allocations.length === 0
        ) {
          return new Response(
            JSON.stringify({
              error:
                "Missing required inputs: putaway_task_id and allocations array matching layout are required.",
            }),
            { status: 400, headers: corsHeaders },
          );
        }

        const originalTask = await env.DB.prepare(
          `SELECT pt.id, pt.shipment_id, pt.client_id, sd.stock_owner_id 
   FROM putaway_tasks pt 
   JOIN shipment_details sd ON pt.shipment_id = sd.id 
   WHERE pt.id = ? AND pt.warehouse_id = ? AND pt.status = 'pending'`,
        )
          .bind(putaway_task_id, auth.context.warehouse_id)
          .first();

        if (!originalTask) {
          return new Response(
            JSON.stringify({
              error:
                "Task not found or has already been closed by another operating user.",
            }),
            { status: 404, headers: corsHeaders },
          );
        }

        const originalItems = await env.DB.prepare(
          `SELECT pti.id, pti.item_code, pti.quantity_to_place, pti.category, pti.manufacturing_date, 
          pti.expiry_date, pti.batch_number, pti.shipment_line_item_id, pti.uom, 
          sli.case_conversion_qty 
          FROM putaway_task_items pti
          LEFT JOIN shipment_line_items sli ON pti.shipment_line_item_id = sli.id
          WHERE pti.putaway_task_id = ?`,
        )
          .bind(putaway_task_id)
          .all();

        const expectedTotals = {};
        const batchMetaByItemCode = {};

        for (const targetItem of originalItems.results) {
          expectedTotals[targetItem.item_code] =
            (expectedTotals[targetItem.item_code] || 0) +
            targetItem.quantity_to_place;
          if (!(targetItem.item_code in batchMetaByItemCode)) {
            batchMetaByItemCode[targetItem.item_code] = {
              source_reference_id: targetItem.id,
              category: targetItem.category ?? null,
              manufacturing_date: targetItem.manufacturing_date ?? null,
              expiry_date: targetItem.expiry_date ?? null,
              batch_number: targetItem.batch_number ?? null,
              case_conversion_qty: targetItem.case_conversion_qty ?? null,
              shipment_line_item_id: targetItem.shipment_line_item_id,
              uom: targetItem.uom,
            };
          }
        }

        const submittedTotals = {};
        for (const alloc of allocations) {
          const qty =
            parseFloat(String(alloc.quantity || 0).replace(/,/g, "")) || 0;
          if (qty <= 0) continue;
          submittedTotals[alloc.item_code] =
            (submittedTotals[alloc.item_code] || 0) + qty;
        }

        for (const code of Object.keys(expectedTotals)) {
          const expected = expectedTotals[code];
          const submitted = submittedTotals[code] || 0;
          if (Math.abs(expected - submitted) > 0.001) {
            return new Response(
              JSON.stringify({
                error: `Quantity verification failure for item '${code}'. Expected total allocation of ${expected} units, but received split assignments summation of ${submitted} units.`,
              }),
              { status: 400, headers: corsHeaders },
            );
          }
        }

        const batchStatements = [];

        for (const alloc of allocations) {
          const targetLocationId = String(alloc.location_id || "")
            .trim()
            .toUpperCase();
          const targetQty =
            parseFloat(String(alloc.quantity || 0).replace(/,/g, "")) || 0;
          const cleanItemCode = String(alloc.item_code || "").trim();
          const cleanItemDesc = String(
            alloc.item_description || "Unknown Item",
          ).trim();

          if (targetQty <= 0 || !targetLocationId) continue;

          const validLocation = await env.DB.prepare(
            "SELECT id FROM locations WHERE id = ? AND warehouse_id = ?",
          )
            .bind(targetLocationId, auth.context.warehouse_id)
            .first();

          if (!validLocation) {
            return new Response(
              JSON.stringify({
                error: `Location layout mismatch: The location label '${targetLocationId}' does not exist in your warehouse directory configuration.`,
              }),
              { status: 400, headers: corsHeaders },
            );
          }

          const itemBatchMeta = batchMetaByItemCode[cleanItemCode] || {};

          batchStatements.push(
            env.DB.prepare(
              `INSERT INTO inventory (
        id, shipment_line_item_id, inventory_source, source_reference_id, warehouse_id, location_id, item_code, 
        item_description, quantity, uom, category, manufacturing_date, expiry_date, batch_number, case_conversion_qty, client_id, stock_owner_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).bind(
              "inv_" + crypto.randomUUID(),
              itemBatchMeta.shipment_line_item_id,
              "putaway",
              itemBatchMeta.source_reference_id,
              auth.context.warehouse_id,
              targetLocationId,
              cleanItemCode,
              cleanItemDesc,
              targetQty,
              itemBatchMeta.uom || "PCS",
              itemBatchMeta.category,
              itemBatchMeta.manufacturing_date,
              itemBatchMeta.expiry_date,
              itemBatchMeta.batch_number,
              itemBatchMeta.case_conversion_qty ?? null,
              originalTask.client_id,
              originalTask.stock_owner_id,
            ),
          );

          batchStatements.push(
            env.DB.prepare(
              `INSERT INTO putaway_task_item_allocations (id, warehouse_id, putaway_task_item_id, location_id, quantity)
       VALUES (?, ?, ?, ?, ?)`,
            ).bind(
              "alloc_" + crypto.randomUUID(),
              auth.context.warehouse_id,
              itemBatchMeta.source_reference_id,
              targetLocationId,
              targetQty,
            ),
          );
        }

        batchStatements.push(
          env.DB.prepare(
            "UPDATE putaway_tasks SET status = 'completed', completed_by_user_id = ? WHERE id = ? AND warehouse_id = ?",
          ).bind(
            auth.context.user_id,
            putaway_task_id,
            auth.context.warehouse_id,
          ),
        );

        batchStatements.push(
          env.DB.prepare(
            `UPDATE transactions SET status = 'completed', completed_by_user_id = ?, completed_at = CURRENT_TIMESTAMP
     WHERE transaction_type = 'inbound' AND reference_id = ? AND warehouse_id = ?`,
          ).bind(
            auth.context.user_id,
            originalTask.shipment_id,
            auth.context.warehouse_id,
          ),
        );

        await env.DB.batch(batchStatements);

        return new Response(
          JSON.stringify({
            success: true,
            message:
              "Putaway process finalized successfully. Balances up to date.",
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
    // GET /api/inventory -> Select statement updated to include i.client_id
    // =========================================================================
    if (request.method === "GET" && url.pathname === "/api/inventory") {
      const auth = await getTenantContext(request, env);
      if (!auth.success) {
        return new Response(JSON.stringify({ error: auth.error }), {
          status: auth.status,
          headers: corsHeaders,
        });
      }

      if (auth.context.role === "super_admin") {
        return new Response(JSON.stringify({ error: "Access Denied" }), {
          status: 403,
          headers: corsHeaders,
        });
      }

      try {
        const inventoryBalances = await env.DB.prepare(
          `SELECT 
    i.id, i.shipment_line_item_id, i.inventory_source, i.source_reference_id, i.warehouse_id, i.location_id, 
    i.item_code, i.item_description, i.quantity, i.reserved_quantity, (i.quantity - i.reserved_quantity) AS available_quantity, i.uom, i.category, i.manufacturing_date, 
    i.expiry_date, i.batch_number, i.created_at, i.client_id, i.stock_owner_id,
    c.name AS client_name, c.code AS client_code,
    so.name AS stock_owner_name, so.code AS stock_owner_code,
    u_verified.username AS verified_by, u_putaway.username AS putaway_by
 FROM inventory i
 LEFT JOIN clients c ON i.client_id = c.id
 LEFT JOIN stock_owners so ON i.stock_owner_id = so.id
 LEFT JOIN shipment_line_items sli ON i.shipment_line_item_id = sli.id
 LEFT JOIN shipment_details sd ON sli.shipment_id = sd.id
 LEFT JOIN users u_verified ON sd.verified_by_user_id = u_verified.id
 LEFT JOIN putaway_task_items pti ON i.source_reference_id = pti.id AND i.inventory_source = 'putaway'
 LEFT JOIN putaway_tasks pt ON pti.putaway_task_id = pt.id
 LEFT JOIN users u_putaway ON pt.completed_by_user_id = u_putaway.id
 WHERE i.warehouse_id = ? AND i.quantity > 0
 ORDER BY i.location_id ASC, i.item_code ASC, i.created_at DESC`,
        )
          .bind(auth.context.warehouse_id)
          .all();

        return new Response(
          JSON.stringify({ inventory: inventoryBalances.results }),
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
    // GET /api/clients -> Fetch isolate tenant clients records
    // =========================================================================
    if (request.method === "GET" && url.pathname === "/api/clients") {
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
              "Access Denied: Super Admins lack workspace client assignments.",
          }),
          {
            status: 403,
            headers: corsHeaders,
          },
        );
      }

      try {
        const clientsRows = await env.DB.prepare(
          "SELECT * FROM clients WHERE warehouse_id = ? ORDER BY name ASC",
        )
          .bind(auth.context.warehouse_id)
          .all();

        return new Response(JSON.stringify({ clients: clientsRows.results }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
    }

    // =========================================================================
    // POST /api/clients -> Admin-gated Client Identity Provisioner
    // =========================================================================
    if (request.method === "POST" && url.pathname === "/api/clients") {
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
        const name = String(payload.name || "").trim();
        const code = String(payload.code || "")
          .trim()
          .toUpperCase();
        const gstin = payload.gstin
          ? String(payload.gstin).trim().toUpperCase()
          : null;
        const contactPerson = payload.contact_person
          ? String(payload.contact_person).trim()
          : null;
        const phone = payload.phone ? String(payload.phone).trim() : null;
        const email = payload.email ? String(payload.email).trim() : null;

        if (!name || !code) {
          return new Response(
            JSON.stringify({
              error: "Client Name and Unique Code are mandatory fields.",
            }),
            { status: 400, headers: corsHeaders },
          );
        }

        // Check code uniqueness within this warehouse
        const existingCode = await env.DB.prepare(
          "SELECT id FROM clients WHERE warehouse_id = ? AND code = ?",
        )
          .bind(auth.context.warehouse_id, code)
          .first();

        if (existingCode) {
          return new Response(
            JSON.stringify({
              error: `Client code '${code}' is already in use in this warehouse.`,
            }),
            { status: 409, headers: corsHeaders },
          );
        }

        const newClientId = "cli_" + crypto.randomUUID();
        const defaultStockOwnerId = "so_" + crypto.randomUUID();

        // Atomic transaction: Provision Client and default Stock Owner concurrently
        await env.DB.batch([
          // FIXED: Exactly 11 columns <-> 11 values (8 '?' + 'active' + 1 '?' + NULL)
          env.DB.prepare(
            `INSERT INTO clients (id, warehouse_id, name, code, gstin, contact_person, phone, email, status, created_by_user_id, updated_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL)`,
          ).bind(
            newClientId,
            auth.context.warehouse_id,
            name,
            code,
            gstin,
            contactPerson,
            phone,
            email,
            auth.context.user_id,
          ),

          // FIXED: Exactly 12 columns <-> 12 values (9 '?' + 'active' + 1 '?' + NULL)
          env.DB.prepare(
            `INSERT INTO stock_owners (id, client_id, warehouse_id, name, code, gstin, contact_person, phone, email, status, created_by_user_id, updated_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL)`,
          ).bind(
            defaultStockOwnerId,
            newClientId,
            auth.context.warehouse_id,
            name,
            code,
            gstin,
            contactPerson,
            phone,
            email,
            auth.context.user_id,
          ),
        ]);

        return new Response(
          JSON.stringify({
            success: true,
            message: "Client and Default Stock Owner onboarded successfully.",
            client_id: newClientId,
            default_stock_owner_id: defaultStockOwnerId,
          }),
          {
            status: 201,
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
    // GET /api/stock-owners -> List stock owners (Optionally filtered by client_id)
    // =========================================================================
    if (request.method === "GET" && url.pathname === "/api/stock-owners") {
      const auth = await getTenantContext(request, env);
      if (!auth.success) {
        return new Response(JSON.stringify({ error: auth.error }), {
          status: auth.status,
          headers: corsHeaders,
        });
      }

      try {
        const clientId = url.searchParams.get("client_id");
        let query = `
      SELECT so.*, c.name AS client_name, c.code AS client_code
      FROM stock_owners so
      JOIN clients c ON so.client_id = c.id
      WHERE so.warehouse_id = ?
    `;
        const params = [auth.context.warehouse_id];

        if (clientId) {
          query += " AND so.client_id = ?";
          params.push(clientId);
        }

        query += " ORDER BY so.name ASC";

        const rows = await env.DB.prepare(query)
          .bind(...params)
          .all();

        return new Response(JSON.stringify({ stock_owners: rows.results }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
    }

    // =========================================================================
    // POST /api/stock-owners -> Create custom Stock Owner
    // =========================================================================
    if (request.method === "POST" && url.pathname === "/api/stock-owners") {
      const auth = await getTenantContext(request, env);
      if (!auth.success) {
        return new Response(JSON.stringify({ error: auth.error }), {
          status: auth.status,
          headers: corsHeaders,
        });
      }

      // Security Check: Enforce Admin privilege
      if (auth.context.role !== "admin") {
        return new Response(
          JSON.stringify({
            error:
              "Operation Forbidden: Admin access required to create stock owners.",
          }),
          { status: 403, headers: corsHeaders },
        );
      }

      try {
        const payload = await request.json();
        const clientId = String(payload.client_id || "").trim();
        const name = String(payload.name || "").trim();
        const code = String(payload.code || "")
          .trim()
          .toUpperCase();
        const gstin = payload.gstin
          ? String(payload.gstin).trim().toUpperCase()
          : null;
        const contactPerson = payload.contact_person
          ? String(payload.contact_person).trim()
          : null;
        const phone = payload.phone ? String(payload.phone).trim() : null;
        const email = payload.email ? String(payload.email).trim() : null;

        if (!clientId || !name || !code) {
          return new Response(
            JSON.stringify({
              error: "Client, Stock Owner Name, and Unique Code are required.",
            }),
            { status: 400, headers: corsHeaders },
          );
        }

        // Verify parent client exists in this warehouse tenant
        const clientExists = await env.DB.prepare(
          "SELECT id FROM clients WHERE id = ? AND warehouse_id = ?",
        )
          .bind(clientId, auth.context.warehouse_id)
          .first();

        if (!clientExists) {
          return new Response(
            JSON.stringify({
              error: "Selected Client does not exist in this warehouse.",
            }),
            { status: 404, headers: corsHeaders },
          );
        }

        // Code uniqueness check within warehouse tenant
        const codeExists = await env.DB.prepare(
          "SELECT id FROM stock_owners WHERE warehouse_id = ? AND code = ?",
        )
          .bind(auth.context.warehouse_id, code)
          .first();

        if (codeExists) {
          return new Response(
            JSON.stringify({
              error: `Stock Owner code '${code}' already exists in this warehouse.`,
            }),
            { status: 409, headers: corsHeaders },
          );
        }

        const newOwnerId = "so_" + crypto.randomUUID();

        // Exactly 11 columns <-> 11 values (10 '?' placeholders + 1 literal)
        await env.DB.prepare(
          `INSERT INTO stock_owners (id, client_id, warehouse_id, name, code, gstin, contact_person, phone, email, status, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
        )
          .bind(
            newOwnerId,
            clientId,
            auth.context.warehouse_id,
            name,
            code,
            gstin,
            contactPerson,
            phone,
            email,
            auth.context.user_id,
          )
          .run();

        return new Response(
          JSON.stringify({
            success: true,
            message: "Stock Owner created successfully.",
            stock_owner_id: newOwnerId,
          }),
          {
            status: 201,
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

    // POST /api/opening-stock/validate
    if (
      request.method === "POST" &&
      url.pathname === "/api/opening-stock/validate"
    ) {
      const auth = await getTenantContext(request, env);
      if (!auth.success)
        return new Response(JSON.stringify({ error: auth.error }), {
          status: auth.status,
          headers: corsHeaders,
        });

      try {
        const formData = await request.formData();
        const file = formData.get("file");
        if (!file)
          return new Response(
            JSON.stringify({ error: "No Excel file uploaded." }),
            { status: 400, headers: corsHeaders },
          );

        const arrayBuffer = await file.arrayBuffer();
        const result = parseAndValidateExcel(arrayBuffer);

        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
    }

    // POST /api/opening-stock/import
    if (
      request.method === "POST" &&
      url.pathname === "/api/opening-stock/import"
    ) {
      const auth = await getTenantContext(request, env);
      if (!auth.success)
        return new Response(JSON.stringify({ error: auth.error }), {
          status: auth.status,
          headers: corsHeaders,
        });

      try {
        const formData = await request.formData();
        const file = formData.get("file");
        const clientId = formData.get("client_id");
        const stockOwnerId = formData.get("stock_owner_id");

        if (!file || !clientId || !stockOwnerId) {
          return new Response(
            JSON.stringify({
              error:
                "Missing required import parameters (file, client_id, stock_owner_id).",
            }),
            { status: 400, headers: corsHeaders },
          );
        }

        const arrayBuffer = await file.arrayBuffer();
        const validation = parseAndValidateExcel(arrayBuffer);

        if (!validation.isValid) {
          return new Response(
            JSON.stringify({
              error: "Import rejected due to validation errors.",
              errors: validation.errors,
            }),
            { status: 400, headers: corsHeaders },
          );
        }

        const warehouseId = auth.context.warehouse_id;
        const userId = auth.context.user_id;
        const importId = `osi_${crypto.randomUUID().slice(0, 8)}`;
        const transactionId = `tx_os_${crypto.randomUUID().slice(0, 8)}`;

        // Get existing locations to avoid duplicate insertion statements in the atomic batch
        const existingLocationsRes = await env.DB.prepare(
          "SELECT id FROM locations WHERE warehouse_id = ?",
        )
          .bind(warehouseId)
          .all();
        const knownLocationIds = new Set(
          (existingLocationsRes.results || []).map((l) => l.id),
        );

        const dbStatements = [];

        // 1. Insert Opening Stock Import Batch Header
        dbStatements.push(
          env.DB.prepare(
            `INSERT INTO opening_stock_imports (id, warehouse_id, client_id, stock_owner_id, uploaded_by_user_id, total_rows, created_at)
         VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
          ).bind(
            importId,
            warehouseId,
            clientId,
            stockOwnerId,
            userId,
            validation.parsedRows.length,
          ),
        );

        // 2. Insert Transaction Record
        dbStatements.push(
          env.DB.prepare(
            `INSERT INTO transactions (id, warehouse_id, reference_id, client_id, transaction_type, status, created_by_user_id, completed_by_user_id, created_at, completed_at)
         VALUES (?, ?, ?, ?, 'opening_stock', 'completed', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          ).bind(
            transactionId,
            warehouseId,
            importId,
            clientId,
            userId,
            userId,
          ),
        );

        // 3. Process Line Items, Locations, and Live Inventory Records
        for (const row of validation.parsedRows) {
          const locUpper = row.location.toUpperCase();

          if (!knownLocationIds.has(locUpper)) {
            dbStatements.push(
              env.DB.prepare(
                `INSERT INTO locations (id, warehouse_id, status) VALUES (?, ?, 'available')`,
              ).bind(locUpper, warehouseId),
            );
            knownLocationIds.add(locUpper);
          }

          const lineItemId = `osli_${crypto.randomUUID().slice(0, 8)}`;
          dbStatements.push(
            env.DB.prepare(
              `INSERT INTO opening_stock_line_items (id, opening_stock_import_id, item_code, item_description, quantity, uom, category, batch_number, manufacturing_date, expiry_date, case_conversion_qty, location_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
            ).bind(
              lineItemId,
              importId,
              row.item_code,
              row.item_description,
              row.quantity,
              row.uom,
              row.category,
              row.batch_number,
              row.manufacturing_date,
              row.expiry_date,
              row.case_conversion_qty ?? null,
              locUpper,
            ),
          );

          const inventoryId = `inv_os_${crypto.randomUUID().slice(0, 8)}`;
          dbStatements.push(
            env.DB.prepare(
              `INSERT INTO inventory (id, inventory_source, source_reference_id, shipment_line_item_id, warehouse_id, client_id, stock_owner_id, location_id, item_code, item_description, quantity, uom, category, manufacturing_date, expiry_date, batch_number, case_conversion_qty, created_at)
           VALUES (?, 'opening_stock', ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
            ).bind(
              inventoryId,
              lineItemId,
              warehouseId,
              clientId,
              stockOwnerId,
              locUpper,
              row.item_code,
              row.item_description,
              row.quantity,
              row.uom,
              row.category,
              row.manufacturing_date,
              row.expiry_date,
              row.batch_number,
              row.case_conversion_qty ?? null,
            ),
          );
        }

        // Execute atomic transaction rollback if any statement fails
        console.log("Statements:", dbStatements.length);
        await env.DB.batch(dbStatements);
        console.log("Batch completed");
        return new Response(
          JSON.stringify({
            success: true,
            opening_stock_import_id: importId,
            transaction_id: transactionId,
            total_rows: validation.parsedRows.length,
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
    // GET /api/transactions
    // =========================================================================
    if (request.method === "GET" && url.pathname === "/api/transactions") {
      const auth = await getTenantContext(request, env);
      if (!auth.success)
        return new Response(JSON.stringify({ error: auth.error }), {
          status: auth.status,
          headers: corsHeaders,
        });

      try {
        const registry = await env.DB.prepare(
          `SELECT
         t.id AS transaction_id, t.transaction_type, t.status, t.reference_id AS entity_id,
         t.warehouse_id, t.created_at, t.completed_at, t.client_id, c.name AS client_name, c.code AS client_code,
         COALESCE(sd.invoice_number, osd.eway_bill_number) AS invoice_number,
         sd.invoice_date, COALESCE(sd.vehicle_number, osd.vehicle_number) AS vehicle_number,
         COALESCE(u_inbound.username, u_os.username, u_outbound.username) AS verified_by
       FROM transactions t
       LEFT JOIN clients c ON t.client_id = c.id
       LEFT JOIN shipment_details sd ON sd.id = t.reference_id AND t.transaction_type = 'inbound'
       LEFT JOIN users u_inbound ON u_inbound.id = sd.verified_by_user_id
       LEFT JOIN opening_stock_imports osi ON osi.id = t.reference_id AND t.transaction_type = 'opening_stock'
       LEFT JOIN users u_os ON u_os.id = osi.uploaded_by_user_id
       LEFT JOIN outbound_shipment_details osd ON osd.id = t.reference_id AND t.transaction_type = 'outbound'
       LEFT JOIN users u_outbound ON u_outbound.id = osd.verified_by_user_id
       WHERE t.warehouse_id = ? AND t.transaction_type IN ('inbound', 'opening_stock', 'outbound', 'stock_adjustment')
       ORDER BY t.created_at DESC`,
        )
          .bind(auth.context.warehouse_id)
          .all();

        return new Response(
          JSON.stringify({ transactions: registry.results }),
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
    // GET /api/transactions/:id -> Unified Transaction Details Selector Fetcher
    // =========================================================================
    const transactionDetailMatch = url.pathname.match(
      /^\/api\/transactions\/([^/]+)$/,
    );
    if (request.method === "GET" && transactionDetailMatch) {
      const auth = await getTenantContext(request, env);
      if (!auth.success) {
        return new Response(JSON.stringify({ error: auth.error }), {
          status: auth.status,
          headers: corsHeaders,
        });
      }

      try {
        const transactionId = transactionDetailMatch[1];
        const transaction = await env.DB.prepare(
          `SELECT t.*, c.name AS client_name, c.code AS client_code 
       FROM transactions t 
       LEFT JOIN clients c ON t.client_id = c.id 
       WHERE t.id = ? AND t.warehouse_id = ?`,
        )
          .bind(transactionId, auth.context.warehouse_id)
          .first();

        if (!transaction) {
          return new Response(
            JSON.stringify({ error: "Transaction not found." }),
            {
              status: 404,
              headers: corsHeaders,
            },
          );
        }

        const resolveParty = async (partyId) => {
          if (!partyId) return null;
          try {
            const party = await env.DB.prepare(
              `SELECT name, gstin, address FROM parties WHERE id = ? AND warehouse_id = ?`,
            )
              .bind(partyId, auth.context.warehouse_id)
              .first();
            return party || null;
          } catch (err) {
            return null;
          }
        };

        const detailLoaders = {
          inbound: async () => {
            const shipment = await env.DB.prepare(
              `SELECT sd.*, u.username AS verified_by, cl.name AS client_name, cl.code AS client_code
           FROM shipment_details sd
           LEFT JOIN users u ON u.id = sd.verified_by_user_id
           LEFT JOIN clients cl ON sd.client_id = cl.id
           WHERE sd.id = ? AND sd.warehouse_id = ?`,
            )
              .bind(transaction.reference_id, auth.context.warehouse_id)
              .first();

            const lineItems = await env.DB.prepare(
              "SELECT * FROM shipment_line_items WHERE shipment_id = ? ORDER BY rowid ASC",
            )
              .bind(transaction.reference_id)
              .all();

            const [seller, bill_to, ship_to] = shipment
              ? await Promise.all([
                  resolveParty(shipment.seller_party_id),
                  resolveParty(shipment.bill_to_party_id),
                  resolveParty(shipment.ship_to_party_id),
                ])
              : [null, null, null];

            return {
              shipment_header: shipment || null,
              shipment_line_items: lineItems.results,
              parties: { seller, bill_to, ship_to },
            };
          },
          opening_stock: async () => {
            const importHeader = await env.DB.prepare(
              `SELECT osi.*, u.username AS uploaded_by, 
                  cl.name AS client_name, cl.code AS client_code,
                  so.name AS stock_owner_name, so.code AS stock_owner_code
           FROM opening_stock_imports osi
           LEFT JOIN users u ON u.id = osi.uploaded_by_user_id
           LEFT JOIN clients cl ON osi.client_id = cl.id
           LEFT JOIN stock_owners so ON osi.stock_owner_id = so.id
           WHERE osi.id = ? AND osi.warehouse_id = ?`,
            )
              .bind(transaction.reference_id, auth.context.warehouse_id)
              .first();

            const lineItems = await env.DB.prepare(
              `SELECT osli.*
           FROM opening_stock_line_items osli
           WHERE osli.opening_stock_import_id = ?
           ORDER BY osli.rowid ASC`,
            )
              .bind(transaction.reference_id)
              .all();

            return {
              import_header: importHeader || null,
              opening_stock_line_items: lineItems.results || [],
            };
          },
          outbound: async () => {
            const shipment = await env.DB.prepare(
              `SELECT osd.*, 
                  u_created.username AS created_by,
                  u_verified.username AS verified_by, 
                  cl.name AS client_name, 
                  cl.code AS client_code
           FROM outbound_shipment_details osd
           LEFT JOIN users u_created ON u_created.id = osd.created_by_user_id
           LEFT JOIN users u_verified ON u_verified.id = osd.verified_by_user_id
           LEFT JOIN clients cl ON osd.client_id = cl.id
           WHERE osd.id = ? AND osd.warehouse_id = ?`,
            )
              .bind(transaction.reference_id, auth.context.warehouse_id)
              .first();

            const lineItems = await env.DB.prepare(
              `SELECT osli.*, so.name AS stock_owner_name, so.code AS stock_owner_code
           FROM outbound_shipment_line_items osli
           LEFT JOIN stock_owners so ON osli.stock_owner_id = so.id
           WHERE osli.outbound_shipment_detail_id = ? 
           ORDER BY osli.rowid ASC`,
            )
              .bind(transaction.reference_id)
              .all();

            const pickingTasks = await env.DB.prepare(
              `SELECT pt.*, 
                  u_created.username AS created_by,
                  u_completed.username AS completed_by
           FROM picking_tasks pt
           LEFT JOIN users u_created ON u_created.id = pt.created_by_user_id
           LEFT JOIN users u_completed ON u_completed.id = pt.completed_by_user_id
           WHERE pt.outbound_shipment_detail_id = ? 
           ORDER BY pt.created_at ASC`,
            )
              .bind(transaction.reference_id)
              .all();

            return {
              shipment_header: shipment || null,
              outbound_shipment_line_items: lineItems.results || [],
              picking_tasks: pickingTasks.results || [],
            };
          },
          stock_adjustment: async () => {
            const adj = await env.DB.prepare(
              `SELECT sa.*, u.username AS performed_by, cl.name AS client_name, cl.code AS client_code
               FROM stock_adjustments sa
               LEFT JOIN users u ON u.id = sa.created_by_user_id
               LEFT JOIN clients cl ON sa.client_id = cl.id
               WHERE sa.id = ? AND sa.warehouse_id = ?`,
            )
              .bind(transaction.reference_id, auth.context.warehouse_id)
              .first();

            return { adjustment_detail: adj || null };
          },
        };

        const loader = detailLoaders[transaction.transaction_type];
        if (!loader) {
          return new Response(
            JSON.stringify({
              error: `Unsupported transaction type: ${transaction.transaction_type}`,
            }),
            {
              status: 400,
              headers: corsHeaders,
            },
          );
        }

        const moduleDetail = await loader();
        return new Response(JSON.stringify({ transaction, ...moduleDetail }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
    }

    // =========================================================================
    // GET /api/outbound/pending -> AI-upload outbound shipments awaiting verification
    // =========================================================================
    if (request.method === "GET" && url.pathname === "/api/outbound/pending") {
      const auth = await getTenantContext(request, env);
      if (!auth.success) {
        return new Response(JSON.stringify({ error: auth.error }), {
          status: auth.status,
          headers: corsHeaders,
        });
      }

      try {
        const pending = await env.DB.prepare(
          "SELECT id, status, created_at FROM outbound_shipments WHERE warehouse_id = ? AND status != 'completed' ORDER BY created_at DESC",
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

    if (request.method === "GET" && url.pathname === "/api/outbound/staged") {
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
          "SELECT id, status, staging_json FROM outbound_shipments WHERE id = ? AND warehouse_id = ?",
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

    // =========================================================================
    // POST /api/outbound/verify -> Validation-only. Never writes to the DB.
    // Used by BOTH the AI-upload flow and Manual Entry (there is no separate
    // manual-create endpoint — Manual Entry just posts a blank-form-filled
    // payload here first).
    // =========================================================================
    if (request.method === "POST" && url.pathname === "/api/outbound/verify") {
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
              parseFloat(
                String(item.requested_quantity || 0).replace(/,/g, ""),
              ) || 0;

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

    // =========================================================================
    // POST /api/outbound/commit -> All database writes happen here. Re-runs
    // allocation fresh against current stock (does NOT trust the allocation
    // the client received from /api/outbound/verify) so a race between two
    // concurrent orders never oversells the same inventory.
    // =========================================================================
    if (request.method === "POST" && url.pathname === "/api/outbound/commit") {
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
        // outbound_shipment_details.id is generated below.
        if (shipmentId) {
          const stagingVerification = await env.DB.prepare(
            "SELECT id FROM outbound_shipments WHERE id = ? AND warehouse_id = ?",
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
            parseFloat(
              String(item.requested_quantity || 0).replace(/,/g, ""),
            ) || 0;

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
            `INSERT INTO outbound_shipment_details
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
              `INSERT INTO outbound_shipment_line_items
                (id, outbound_shipment_detail_id, stock_owner_id, item_code, item_description, uom, requested_quantity)
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
              ).bind(
                alloc.quantity,
                alloc.inventory_id,
                auth.context.warehouse_id,
              ),
            );
          }
        }

        if (shipmentId) {
          batchStatements.push(
            env.DB.prepare(
              "UPDATE outbound_shipments SET status = 'completed', staging_json = NULL WHERE id = ? AND warehouse_id = ?",
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
            outbound_shipment_detail_id: outboundDetailId,
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

    // =========================================================================
    // GET /api/picking/pending & /api/picking/completed
    // =========================================================================
    if (request.method === "GET" && url.pathname === "/api/picking/pending") {
      const auth = await getTenantContext(request, env);
      if (!auth.success) {
        return new Response(JSON.stringify({ error: auth.error }), {
          status: auth.status,
          headers: corsHeaders,
        });
      }

      try {
        const tasks = await env.DB.prepare(
          `SELECT pt.id, pt.status, pt.created_at, pt.client_id, 
              c.name AS client_name, c.code AS client_code,
              osd.eway_bill_number, osd.vehicle_number, osd.transporter_name,
              u.username AS created_by
       FROM picking_tasks pt
       LEFT JOIN clients c ON pt.client_id = c.id
       LEFT JOIN outbound_shipment_details osd ON pt.outbound_shipment_detail_id = osd.id
       LEFT JOIN users u ON pt.created_by_user_id = u.id
       WHERE pt.warehouse_id = ? AND pt.status = 'pending'
       ORDER BY pt.created_at ASC`,
        )
          .bind(auth.context.warehouse_id)
          .all();

        const taskIds = tasks.results.map((t) => t.id);
        let itemsByTask = {};
        if (taskIds.length > 0) {
          const placeholders = taskIds.map(() => "?").join(",");
          const items = await env.DB.prepare(
            `SELECT pti.*, inv.manufacturing_date, inv.case_conversion_qty 
         FROM picking_task_items pti
         LEFT JOIN inventory inv ON pti.inventory_id = inv.id
         WHERE pti.picking_task_id IN (${placeholders}) 
         ORDER BY pti.rowid ASC`,
          )
            .bind(...taskIds)
            .all();
          for (const item of items.results) {
            if (!itemsByTask[item.picking_task_id])
              itemsByTask[item.picking_task_id] = [];
            itemsByTask[item.picking_task_id].push(item);
          }
        }

        const enriched = tasks.results.map((t) => ({
          ...t,
          items: itemsByTask[t.id] || [],
        }));

        return new Response(JSON.stringify({ tasks: enriched }), {
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

    if (request.method === "GET" && url.pathname === "/api/picking/completed") {
      const auth = await getTenantContext(request, env);
      if (!auth.success) {
        return new Response(JSON.stringify({ error: auth.error }), {
          status: auth.status,
          headers: corsHeaders,
        });
      }

      try {
        const tasks = await env.DB.prepare(
          `SELECT pt.id, pt.status, pt.created_at, pt.completed_at, pt.client_id, 
              c.name AS client_name, c.code AS client_code,
              osd.eway_bill_number, osd.vehicle_number, osd.transporter_name,
              u1.username AS created_by,
              u2.username AS completed_by
       FROM picking_tasks pt
       LEFT JOIN clients c ON pt.client_id = c.id
       LEFT JOIN outbound_shipment_details osd ON pt.outbound_shipment_detail_id = osd.id
       LEFT JOIN users u1 ON pt.created_by_user_id = u1.id
       LEFT JOIN users u2 ON pt.completed_by_user_id = u2.id
       WHERE pt.warehouse_id = ? AND pt.status = 'completed'
       ORDER BY pt.completed_at DESC`,
        )
          .bind(auth.context.warehouse_id)
          .all();

        const taskIds = tasks.results.map((t) => t.id);
        let itemsByTask = {};
        if (taskIds.length > 0) {
          const placeholders = taskIds.map(() => "?").join(",");
          const items = await env.DB.prepare(
            `SELECT pti.*, inv.manufacturing_date, inv.case_conversion_qty 
         FROM picking_task_items pti
         LEFT JOIN inventory inv ON pti.inventory_id = inv.id
         WHERE pti.picking_task_id IN (${placeholders}) 
         ORDER BY pti.rowid ASC`,
          )
            .bind(...taskIds)
            .all();
          for (const item of items.results) {
            if (!itemsByTask[item.picking_task_id])
              itemsByTask[item.picking_task_id] = [];
            itemsByTask[item.picking_task_id].push(item);
          }
        }

        const enriched = tasks.results.map((t) => ({
          ...t,
          items: itemsByTask[t.id] || [],
        }));

        return new Response(JSON.stringify({ tasks: enriched }), {
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

    // =========================================================================
    // POST /api/picking/complete -> quantity -= picked_quantity, reserved_quantity -= picked_quantity.
    // Never deletes inventory rows. Matches picking_task_items back to inventory
    // via the stored inventory_id (no ambiguous re-matching on description fields).
    // =========================================================================
    if (request.method === "POST" && url.pathname === "/api/picking/complete") {
      const auth = await getTenantContext(request, env);
      if (!auth.success) {
        return new Response(JSON.stringify({ error: auth.error }), {
          status: auth.status,
          headers: corsHeaders,
        });
      }

      if (auth.context.role === "viewer") {
        return new Response(
          JSON.stringify({
            error:
              "Operation Forbidden: Viewers cannot register physical warehouse stock actions.",
          }),
          { status: 403, headers: corsHeaders },
        );
      }

      try {
        const payload = await request.json();
        const { picking_task_id, picked_items } = payload;

        if (
          !picking_task_id ||
          !Array.isArray(picked_items) ||
          picked_items.length === 0
        ) {
          return new Response(
            JSON.stringify({
              error:
                "Missing required inputs: picking_task_id and picked_items array are required.",
            }),
            { status: 400, headers: corsHeaders },
          );
        }

        const originalTask = await env.DB.prepare(
          "SELECT id, outbound_shipment_detail_id FROM picking_tasks WHERE id = ? AND warehouse_id = ? AND status = 'pending'",
        )
          .bind(picking_task_id, auth.context.warehouse_id)
          .first();

        if (!originalTask) {
          return new Response(
            JSON.stringify({
              error:
                "Task not found or has already been closed by another operating user.",
            }),
            { status: 404, headers: corsHeaders },
          );
        }

        const originalItems = await env.DB.prepare(
          "SELECT id, inventory_id, quantity_to_pick FROM picking_task_items WHERE picking_task_id = ?",
        )
          .bind(picking_task_id)
          .all();

        const originalById = {};
        for (const row of originalItems.results) originalById[row.id] = row;

        const batchStatements = [];

        for (const picked of picked_items) {
          const original = originalById[picked.picking_task_item_id];
          if (!original) {
            return new Response(
              JSON.stringify({
                error: "Picked item does not belong to this picking task.",
              }),
              { status: 400, headers: corsHeaders },
            );
          }

          const pickedQty =
            parseFloat(
              String(
                picked.picked_quantity ?? original.quantity_to_pick,
              ).replace(/,/g, ""),
            ) || 0;
          if (pickedQty <= 0 || pickedQty > original.quantity_to_pick + 0.001) {
            return new Response(
              JSON.stringify({
                error: "Picked quantity is invalid for one of the line items.",
              }),
              { status: 400, headers: corsHeaders },
            );
          }

          batchStatements.push(
            env.DB.prepare(
              "UPDATE inventory SET quantity = quantity - ?, reserved_quantity = reserved_quantity - ? WHERE id = ? AND warehouse_id = ?",
            ).bind(
              pickedQty,
              pickedQty,
              original.inventory_id,
              auth.context.warehouse_id,
            ),
          );

          batchStatements.push(
            env.DB.prepare(
              "UPDATE picking_task_items SET status = 'picked' WHERE id = ?",
            ).bind(original.id),
          );
        }

        batchStatements.push(
          env.DB.prepare(
            "UPDATE picking_tasks SET status = 'completed', completed_by_user_id = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ? AND warehouse_id = ?",
          ).bind(
            auth.context.user_id,
            picking_task_id,
            auth.context.warehouse_id,
          ),
        );

        batchStatements.push(
          env.DB.prepare(
            "UPDATE outbound_shipment_details SET status = 'completed' WHERE id = ? AND warehouse_id = ?",
          ).bind(
            originalTask.outbound_shipment_detail_id,
            auth.context.warehouse_id,
          ),
        );

        batchStatements.push(
          env.DB.prepare(
            `UPDATE transactions SET status = 'completed', completed_by_user_id = ?, completed_at = CURRENT_TIMESTAMP
             WHERE transaction_type = 'outbound' AND reference_id = ? AND warehouse_id = ?`,
          ).bind(
            auth.context.user_id,
            originalTask.outbound_shipment_detail_id,
            auth.context.warehouse_id,
          ),
        );

        await env.DB.batch(batchStatements);

        return new Response(
          JSON.stringify({
            success: true,
            message: "Picking completed successfully. Balances up to date.",
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
    // BILLING MODULE — manual invoice creation. No automatic calculation of
    // any kind; every numeric field is entered and trusted as-is from the
    // client. status is binary: 'pending' -> 'paid' (one-way, via mark-paid).
    // Hierarchical items: billing_main_items (HSN/SAC category) each with
    // billing_sub_items (breakdown lines). tax_type is 'intra' (CGST+SGST)
    // or 'inter' (IGST), derived client-side from wh_state_code vs the
    // buyer's place_of_supply state code, but trusted as sent since the
    // client already computed cgst/sgst/igst amounts consistently with it.
    // =========================================================================

    // -------------------------------------------------------------------------
    // GET /api/billing -> List bills for this warehouse (filters: search, client_id, status)
    // -------------------------------------------------------------------------
    if (request.method === "GET" && url.pathname === "/api/billing") {
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
    if (request.method === "POST" && url.pathname === "/api/billing") {
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
    const billingAttachmentUploadMatch = url.pathname.match(
      /^\/api\/billing\/([^/]+)\/attachments$/,
    );
    if (request.method === "POST" && billingAttachmentUploadMatch) {
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
        const billingId = billingAttachmentUploadMatch[1];
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
    const billingAttachmentDeleteMatch = url.pathname.match(
      /^\/api\/billing\/attachments\/([^/]+)$/,
    );
    if (request.method === "DELETE" && billingAttachmentDeleteMatch) {
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
        const attachmentId = billingAttachmentDeleteMatch[1];
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
    const billingMarkPaidMatch = url.pathname.match(
      /^\/api\/billing\/([^/]+)\/mark-paid$/,
    );
    if (request.method === "POST" && billingMarkPaidMatch) {
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
        const billingId = billingMarkPaidMatch[1];
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
    // PUT /api/billing/:id -> Edit a bill (only while status = 'pending')
    // DELETE /api/billing/:id -> Delete a bill (only while status = 'pending')
    // -------------------------------------------------------------------------
    const billingDetailMatch = url.pathname.match(/^\/api\/billing\/([^/]+)$/);

    if (request.method === "GET" && billingDetailMatch) {
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
        const billingId = billingDetailMatch[1];
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

    if (request.method === "PUT" && billingDetailMatch) {
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
        const billingId = billingDetailMatch[1];
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

    if (request.method === "DELETE" && billingDetailMatch) {
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
        const billingId = billingDetailMatch[1];
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

    // =========================================================================
    // POST /api/inventory/adjust -> Stock Adjustment Endpoint
    // =========================================================================
    if (request.method === "POST" && url.pathname === "/api/inventory/adjust") {
      const auth = await getTenantContext(request, env);
      if (!auth.success) {
        return new Response(JSON.stringify({ error: auth.error }), {
          status: auth.status,
          headers: corsHeaders,
        });
      }

      if (auth.context.role === "viewer") {
        return new Response(
          JSON.stringify({
            error: "Operation Forbidden: Viewers cannot make adjustments.",
          }),
          { status: 403, headers: corsHeaders },
        );
      }

      try {
        const { inventory_id, physical_quantity, remarks } =
          await request.json();

        if (!inventory_id || physical_quantity === undefined || !remarks) {
          return new Response(
            JSON.stringify({
              error:
                "Inventory ID, physical quantity, and remarks are mandatory.",
            }),
            { status: 400, headers: corsHeaders },
          );
        }

        const invRow = await env.DB.prepare(
          "SELECT * FROM inventory WHERE id = ? AND warehouse_id = ?",
        )
          .bind(inventory_id, auth.context.warehouse_id)
          .first();

        if (!invRow) {
          return new Response(
            JSON.stringify({ error: "Inventory record not found." }),
            { status: 404, headers: corsHeaders },
          );
        }

        const systemQuantity = invRow.quantity;
        const delta = physical_quantity - systemQuantity;

        if (delta === 0) {
          return new Response(
            JSON.stringify({
              error:
                "Physical quantity matches current system quantity. No adjustment needed.",
            }),
            { status: 400, headers: corsHeaders },
          );
        }

        const adjustmentId = "adj_" + crypto.randomUUID();
        const transactionId = "txn_" + crypto.randomUUID();

        // Batch Database Updates
        await env.DB.batch([
          // 1. Log Stock Adjustment details
          env.DB.prepare(
            `
            INSERT INTO stock_adjustments (
              id, warehouse_id, client_id, stock_owner_id, inventory_id, location_id,
              item_code, item_description, batch_number, system_quantity, physical_quantity,
              delta_quantity, uom, remarks, created_by_user_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          ).bind(
            adjustmentId,
            auth.context.warehouse_id,
            invRow.client_id,
            invRow.stock_owner_id,
            invRow.id,
            invRow.location_id,
            invRow.item_code,
            invRow.item_description,
            invRow.batch_number,
            systemQuantity,
            physical_quantity,
            delta,
            invRow.uom,
            remarks,
            auth.context.user_id,
          ),

          // 2. Update live inventory quantity
          env.DB.prepare(
            `
            UPDATE inventory SET quantity = ? WHERE id = ? AND warehouse_id = ?
          `,
          ).bind(physical_quantity, inventory_id, auth.context.warehouse_id),

          // 3. Write transaction audit record
          env.DB.prepare(
            `
            INSERT INTO transactions (
              id, warehouse_id, reference_id, client_id, transaction_type,
              status, created_by_user_id, completed_by_user_id, created_at, completed_at, remarks
            ) VALUES (?, ?, ?, ?, 'stock_adjustment', 'completed', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)
          `,
          ).bind(
            transactionId,
            auth.context.warehouse_id,
            adjustmentId,
            invRow.client_id,
            auth.context.user_id,
            auth.context.user_id,
            remarks,
          ),
        ]);

        return new Response(
          JSON.stringify({
            success: true,
            message: `Stock adjustment posted successfully (Delta: ${delta > 0 ? "+" : ""}${delta} ${invRow.uom}).`,
            adjustment_id: adjustmentId,
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

    return new Response(JSON.stringify({ error: "Not Found" }), {
      status: 404,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  },

  async queue(batch, env, ctx) {
    for (const message of batch.messages) {
      const task = message.body;

      if (batch.queue === "ocr-queue") {
        try {
          await handleOcrDispatch(task, env);
          message.ack();
        } catch (err) {
          message.retry();
        }
        continue;
      }

      if (batch.queue === "llm-queue") {
        try {
          await handleLlmDispatch(task, env);
          message.ack();
        } catch (err) {
          message.retry();
        }
        continue;
      }
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(sweepStuckJobs(env));
  },
};

// ===========================================================================
// AUTHORITATIVE WATERFALL AGGREGATION MODULE
// ===========================================================================
async function aggregateShipmentData(shipmentId, env) {
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
    "UPDATE inbound_shipments SET staging_json = ?, status = 'pending_verification' WHERE id = ?",
  )
    .bind(JSON.stringify(completeStagingManifest), shipmentId)
    .run();
}

// ==========================================
// OCR DISPATCH — called by ocr-queue consumer
// ==========================================
async function handleOcrDispatch(body, env) {
  const { pageId, shipmentId, imageUrl } = body;

  // Cloudinary on-the-fly resize matching OlmOCR's official 1288px-longest-dim spec
  const resizedUrl = imageUrl.replace(
    "/upload/",
    "/upload/c_limit,w_1288,h_1288/",
  );

  const OCR_PROMPT = `Attached is one page of a document that you must process. Just return the plain text representation of this document as if you were reading it naturally. Convert equations to LateX and tables to HTML.
If there are any figures or charts, label them with the following markdown syntax ![Alt text describing the contents of the figure](page_startx_starty_width_height.png)
Return your output as markdown`;

  const payload = {
    input: {
      openai_input: {
        model: "allenai/olmOCR-2-7B-1025-FP8",
        messages: [
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: resizedUrl } },
              { type: "text", text: OCR_PROMPT },
            ],
          },
        ],
        max_tokens: 3072,
        temperature: 0.0,
        repetition_penalty: 1.2,
      },
    },
    webhook: `${env.WORKER_SELF_URL}/api/ocr/webhook`,
  };

  const resp = await fetch(`${env.RUNPOD_OCR_POD_ORCHESTRATOR_URL}/run`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OCR_POD_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    throw new Error(`Pod OCR dispatch failed: ${resp.status}`);
  }

  const result = await resp.json();

  await env.DB.prepare(
    "UPDATE document_pages SET ocr_status = 'processing', ocr_job_id = ? WHERE id = ?",
  )
    .bind(result.id, pageId)
    .run();
}

// ==========================================
// LLM DISPATCH — called by llm-queue consumer
// ==========================================
async function handleLlmDispatch(body, env) {
  const { pageId, markdown, shipmentId, documentType } = body;
  const shipmentType =
    body.shipmentType === "outbound" ? "outbound" : "inbound";

  if (shipmentType === "outbound") {
    return handleOutboundLlmDispatch(
      { pageId, markdown, shipmentId, documentType },
      env,
    );
  }

  const SYSTEM_PROMPT = `Convert this OCR markdown into a clean, structured JSON object adhering exactly to the schema blueprint defined below.

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
  ],
  "additional_data": {}
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
- total_amount: The final grand total for that item row (taxable_amount + taxes).


additional_data:
- place all other keys which arent specified in the schema in this additional data object.`;

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
    "SELECT id, llm_status FROM document_pages WHERE shipment_id = ?",
  )
    .bind(shipmentId)
    .all();

  if (shipmentPages.every((p) => p.llm_status === "completed")) {
    await aggregateShipmentData(shipmentId, env);
  }
}

// ==========================================
// OUTBOUND LLM DISPATCH — called by handleLlmDispatch() when shipmentType === 'outbound'
// Reuses the same OCR markdown + OpenRouter call pattern as the inbound path,
// with an outbound-specific extraction schema (dispatch/delivery order rather
// than a tax invoice), and aggregates via aggregateOutboundShipmentData().
// ==========================================
async function handleOutboundLlmDispatch(body, env) {
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
    "SELECT id, llm_status FROM document_pages WHERE shipment_id = ? AND shipment_type = 'outbound'",
  )
    .bind(shipmentId)
    .all();

  if (shipmentPages.every((p) => p.llm_status === "completed")) {
    await aggregateOutboundShipmentData(shipmentId, env);
  }
}

// ===========================================================================
// SHARED OUTBOUND ALLOCATION ENGINE — used by both /api/outbound/verify and
// /api/outbound/commit so Commit always recomputes allocation against
// current stock rather than trusting whatever Verify returned earlier.
// FEFO (earliest expiry first) when expiry_date is present, otherwise FIFO
// (oldest created_at first). Read-only: callers decide whether to write.
// ===========================================================================
async function allocateOutboundInventory(
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
async function aggregateOutboundShipmentData(shipmentId, env) {
  const { results } = await env.DB.prepare(
    "SELECT raw_extracted_json FROM document_pages WHERE shipment_id = ? AND shipment_type = 'outbound' AND llm_status = 'completed'",
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
    "UPDATE outbound_shipments SET staging_json = ?, status = 'pending_verification' WHERE id = ?",
  )
    .bind(JSON.stringify(completeStagingManifest), shipmentId)
    .run();
}

// ==========================================
// SWEEPER — runs every 5 min via cron trigger
// Catches OCR pages stuck in 'processing' if the RunPod webhook never arrived.
// LLM calls are now synchronous (OpenRouter, inside the queue consumer), so
// they no longer have a 'processing'-then-webhook window to get stuck in —
// CF Queues' own retry/DLQ mechanism covers LLM failures instead.
// ==========================================
async function sweepStuckJobs(env) {
  // Shorter than before: no cold starts on a dedicated pod, so normal
  // completion is ~60-90s. A page stuck in 'processing' past this means the
  // sidecar's background task died (e.g. pod restart) before it could POST
  // the webhook — there's no job-status endpoint to poll, so just requeue.
  const STUCK_THRESHOLD_MINUTES = 5;

  const stuckOcr = await env.DB.prepare(
    `SELECT id, shipment_id, image_url FROM document_pages
     WHERE ocr_status = 'processing'
     AND datetime(created_at) < datetime('now', ?)`,
  )
    .bind(`-${STUCK_THRESHOLD_MINUTES} minutes`)
    .all();

  for (const row of stuckOcr.results) {
    try {
      await env.OCR_QUEUE.send({
        pageId: row.id,
        shipmentId: row.shipment_id,
        imageUrl: row.image_url,
      });
    } catch (err) {
      console.error(`Sweep requeue failed for page ${row.id}:`, err.message);
    }
  }
}
