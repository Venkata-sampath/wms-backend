/** SWEEPER — runs every 5 min via cron trigger. Catches OCR pages stuck in 'processing' if the RunPod webhook never arrived.**/

export async function sweepStuckJobs(env) {
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
