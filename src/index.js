// src/index.js

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

// 2. Comprehensive CORS headers
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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
        const { company_name, initial_status, admin_username, admin_password } =
          await request.json();

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

        // Batch statement ensures BOTH the warehouse entry and its master account insert together perfectly
        await env.DB.batch([
          env.DB.prepare(
            `
            INSERT INTO warehouses (id, company_name, subscription_status)
            VALUES (?, ?, ?)
          `,
          ).bind(warehouseId, company_name, subscriptionMode),

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
          `SELECT id, company_name, subscription_status, created_at FROM warehouses ORDER BY created_at DESC`,
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

        // LOOKUP UPDATE: Added w.company_name to extract the warehouse name
        const userRow = await env.DB.prepare(
          `
          SELECT u.id, u.username, u.password_hash, u.role, u.is_active, u.warehouse_id, w.subscription_status, w.company_name
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
            "INSERT INTO document_pages (id, shipment_id, image_url, document_type, ocr_status) VALUES (?, ?, ?, ?, 'queued')",
          )
            .bind(pageId, shipmentId, securedUrl, documentType)
            .run();

          // Forward the multi-tenant context boundary downstream through our queue processing message context
          await env.OCR_QUEUE.send({
            pageId,
            shipmentId,
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
          "SELECT id, shipment_id, document_type FROM document_pages WHERE ocr_job_id = ?",
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
        const { shipmentId, header, parties, lineItems } = payload;

        // Security Check: Verify staging record ownership
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

        batchStatements.push(
          env.DB.prepare(
            `INSERT INTO shipment_details (
          id, invoice_number, invoice_date, po_number, lr_number, e_way_bill_number, vehicle_number, driver_name, driver_phone_number,
          seller_party_id, bill_to_party_id, ship_to_party_id, additional_data, warehouse_id, verified_by_user_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          ),
        );

        const putawayTaskId = "ptk_" + crypto.randomUUID();
        batchStatements.push(
          env.DB.prepare(
            "INSERT INTO putaway_tasks (id, warehouse_id, shipment_id, status) VALUES (?, ?, ?, 'pending')",
          ).bind(putawayTaskId, auth.context.warehouse_id, shipmentId),
        );

        if (Array.isArray(lineItems)) {
          for (const item of lineItems) {
            const resolvedCategory = cleanCategory(item.category);
            const resolvedManufacturingDate = cleanDateField(
              item.manufacturing_date,
            );
            const resolvedExpiryDate = cleanDateField(item.expiry_date);

            // Generate the exact shipment line item ID once
            const lineItemId = crypto.randomUUID();
            const verifiedUom = String(item.uom || "PCS").trim();

            batchStatements.push(
              env.DB.prepare(
                `INSERT INTO shipment_line_items (
              id, shipment_id, item_code, item_description, hsn_sac, 
              ordered_quantity, uom, rate, gross_amount, discount_amount, taxable_amount, 
              tax_rate_percent, cgst, sgst, igst, cess, total_amount,
              category, received_quantity, damaged_quantity, shortage_quantity, excess_quantity, 
              discrepancy_uom, discrepancy_notes, manufacturing_date, expiry_date
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
              ),
            );

            const targetPutawayQty = cleanFloat(item.received_quantity);
            if (targetPutawayQty > 0) {
              batchStatements.push(
                env.DB.prepare(
                  `INSERT INTO putaway_task_items (id, putaway_task_id, item_code, item_description, quantity_to_place, category, expiry_date, manufacturing_date, shipment_line_item_id, uom)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                ).bind(
                  "pti_" + crypto.randomUUID(),
                  putawayTaskId,
                  String(item.item_code || "").trim(),
                  String(item.item_description || "Unknown Item").trim(),
                  targetPutawayQty,
                  resolvedCategory,
                  resolvedExpiryDate,
                  resolvedManufacturingDate,
                  lineItemId, // Exact reference mapping
                  verifiedUom, // Forwarded UOM metadata
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

        const transactionId = "txn_" + crypto.randomUUID();
        batchStatements.push(
          env.DB.prepare(
            `INSERT INTO transactions (id, warehouse_id, transaction_type, reference_id, status, created_by_user_id, completed_by_user_id, completed_at, remarks)
        VALUES (?, ?, 'inbound', ?, 'pending_putaway', ?, NULL, NULL, NULL)`,
          ).bind(
            transactionId,
            auth.context.warehouse_id,
            shipmentId,
            auth.context.user_id,
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
    // ENDPOINT: Get Pending Putaway Tasks with Item Lists (SECURED)
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
          `SELECT t.id, t.shipment_id, t.created_at, d.invoice_number, d.vehicle_number 
       FROM putaway_tasks t
       LEFT JOIN shipment_details d ON t.shipment_id = d.id
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

        // Appended shipment_line_item_id and uom fields
        const itemsQuery = await env.DB.prepare(
          `SELECT putaway_task_id, id, item_code, item_description, quantity_to_place, category, manufacturing_date, expiry_date, shipment_line_item_id, uom
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
          "SELECT id, shipment_id FROM putaway_tasks WHERE id = ? AND warehouse_id = ? AND status = 'pending'",
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

        // MODIFIED: Included 'id' in SELECT fields to map putaway_task_item traceability
        const originalItems = await env.DB.prepare(
          "SELECT id, item_code, quantity_to_place, category, manufacturing_date, expiry_date, shipment_line_item_id, uom FROM putaway_task_items WHERE putaway_task_id = ?",
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
              putaway_task_item_id: targetItem.id, // Captured the Putaway Task Item ID
              category: targetItem.category ?? null,
              manufacturing_date: targetItem.manufacturing_date ?? null,
              expiry_date: targetItem.expiry_date ?? null,
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

          // MODIFIED: Added putaway_task_item_id column insertion mapping
          batchStatements.push(
            env.DB.prepare(
              `INSERT INTO inventory (
            id, shipment_line_item_id, putaway_task_item_id, warehouse_id, location_id, item_code, 
            item_description, quantity, uom, category, manufacturing_date, expiry_date
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).bind(
              "inv_" + crypto.randomUUID(),
              itemBatchMeta.shipment_line_item_id,
              itemBatchMeta.putaway_task_item_id, // Bound putaway task item ID
              auth.context.warehouse_id,
              targetLocationId,
              cleanItemCode,
              cleanItemDesc,
              targetQty,
              itemBatchMeta.uom || "PCS",
              itemBatchMeta.category,
              itemBatchMeta.manufacturing_date,
              itemBatchMeta.expiry_date,
            ),
          );
        }

        // MODIFIED: Appended completed_by_user_id context update to the target task
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
            `UPDATE transactions
        SET status = 'completed', completed_by_user_id = ?, completed_at = CURRENT_TIMESTAMP
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
    // ENDPOINT: Get Current Live Inventory Snapshot (SECURED)
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
        // MODIFIED: Configured LEFT JOINs to resolve verified_by and putaway_by names dynamically
        const inventoryBalances = await env.DB.prepare(
          `SELECT 
              i.id, 
              i.shipment_line_item_id, 
              i.putaway_task_item_id,
              i.warehouse_id, 
              i.location_id, 
              i.item_code, 
              i.item_description, 
              i.quantity, 
              i.uom, 
              i.category, 
              i.manufacturing_date, 
              i.expiry_date, 
              i.created_at,
              u_verified.username AS verified_by,
              u_putaway.username AS putaway_by
           FROM inventory i
           LEFT JOIN shipment_line_items sli ON i.shipment_line_item_id = sli.id
           LEFT JOIN shipment_details sd ON sli.shipment_id = sd.id
           LEFT JOIN users u_verified ON sd.verified_by_user_id = u_verified.id
           LEFT JOIN putaway_task_items pti ON i.putaway_task_item_id = pti.id
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

    // ---------------------------------------------------------------------------
    // GET /api/transactions
    //
    // Replaces the old inventory-movement ledger. Returns ONE ROW PER BUSINESS
    // TRANSACTION (one per shipment for inbound), never one row per line item.
    //
    // Only inbound transactions exist today, so the join to shipment_details is
    // hardcoded here. See the note below on how to extend this for outbound /
    // transfer / returns once those module tables exist.
    // ---------------------------------------------------------------------------
    if (request.method === "GET" && url.pathname === "/api/transactions") {
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
        // Today only "inbound" transactions exist, so we join straight to
        // shipment_details. When outbound/transfer/etc. are added, this
        // becomes a UNION of one SELECT per transaction_type, each joining
        // its own module's *_details table, still keyed by transactions.id.
        const registry = await env.DB.prepare(
          `SELECT
             t.id AS transaction_id,
             t.transaction_type,
             t.status,
             t.reference_id AS entity_id,
             t.warehouse_id,
             t.created_at,
             t.completed_at,
             sd.invoice_number,
             sd.invoice_date,
             sd.vehicle_number,
             u.username AS verified_by
           FROM transactions t
           JOIN shipment_details sd ON sd.id = t.reference_id
           LEFT JOIN users u ON u.id = sd.verified_by_user_id
           WHERE t.warehouse_id = ?
             AND t.transaction_type = 'inbound'
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

    // ---------------------------------------------------------------------------
    // GET /api/transactions/:id
    //
    // Loads the full detail of a single business transaction. Dispatches on
    // transaction_type so each module (inbound today, outbound/transfer/returns
    // later) can plug in its own detail loader without touching this router.
    // ---------------------------------------------------------------------------
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
          "SELECT * FROM transactions WHERE id = ? AND warehouse_id = ?",
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
            console.error(`Failed to resolve party ${partyId}:`, err);
            return null;
          }
        };

        const detailLoaders = {
          inbound: async () => {
            const shipment = await env.DB.prepare(
              `SELECT sd.*, u.username AS verified_by
           FROM shipment_details sd
           LEFT JOIN users u ON u.id = sd.verified_by_user_id
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
        };

        const loader = detailLoaders[transaction.transaction_type];
        if (!loader) {
          return new Response(
            JSON.stringify({
              error: `Unsupported transaction type: ${transaction.transaction_type}`,
            }),
            { status: 400, headers: corsHeaders },
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
