// src/utils/cloudinary.js
// Cloudinary signature generation and asset destruction.
// Extracted verbatim from the original index.js.

// 1. Cloudinary helper remains unchanged (it's functionally perfect for Web Crypto)
export async function generateCloudinarySignature(publicId, timestamp, apiSecret) {
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
export async function destroyCloudinaryAsset(publicId, resourceType, env) {
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
