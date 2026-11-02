export function escapeXml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** TwiML response that sends one SMS back to the sender. */
export function twimlMessageResponse(text: string): Response {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>${escapeXml(text)}</Message>
</Response>`;
  return new Response(xml, { headers: { "Content-Type": "text/xml; charset=utf-8" } });
}

/** TwiML with no reply. Twilio sends nothing back to the user. */
export function twimlEmptyResponse(): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<Response/>`, {
    headers: { "Content-Type": "text/xml; charset=utf-8" },
  });
}
