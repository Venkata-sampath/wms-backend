// OCR DISPATCH — called by ocr-queue consumer.

export async function handleOcrDispatch(body, env) {
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
