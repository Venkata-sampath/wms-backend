// src/jobs/sweeper.js
// SWEEPER — runs every 5 min via cron trigger.
// Catches OCR pages stuck in 'processing' if the RunPod webhook never arrived.
// LLM calls are now synchronous (OpenRouter, inside the queue consumer), so
// they no longer have a 'processing'-then-webhook window to get stuck in —
// CF Queues' own retry/DLQ mechanism covers LLM failures instead.
// Extracted verbatim from the original index.js.

export async function sweepStuckJobs(env) {
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
