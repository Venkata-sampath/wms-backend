// src/utils/crypto.js
// Base64url helpers, JWT sign/verify, and password hashing.
// Extracted verbatim from the original index.js (Sections 1-3).

// =========================================================================
// 1. BASE64URL HELPERS (Required for standard JWT specifications)
// =========================================================================
export function base64urlEncode(str) {
  const base64 = btoa(unescape(encodeURIComponent(str)));
  return base64.replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export function base64urlDecode(str) {
  let base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4) base64 += "=";
  return decodeURIComponent(escape(atob(base64)));
}

// =========================================================================
// 2. JWT SIGNING AND VERIFICATION
// =========================================================================
export async function signJWT(payload, secret) {
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

export async function verifyJWT(token, secret) {
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
export async function hashPassword(password) {
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

export async function verifyPassword(password, storedHash) {
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
