/* global Blob, Buffer, FormData, fetch, process, setTimeout */

function syntheticPdf() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 120 80] /Contents 5 0 R >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 80 120] /Contents 6 0 R >>",
    "<< /Length 0 >>\nstream\n\nendstream",
    "<< /Length 0 >>\nstream\n\nendstream",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  pdf += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

const baseUrl = process.argv[2];
if (!baseUrl) throw new Error("Base URL is required");
const receiptResponse = await fetch(`${baseUrl}/api/v1/receipts`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    merchantRaw: "Synthetic Compose",
    purchaseDate: "2026-07-21",
    totalCents: 1,
  }),
});
if (!receiptResponse.ok) throw new Error("Failed to create smoke receipt");
const receipt = await receiptResponse.json();
const form = new FormData();
form.append(
  "document",
  new Blob([syntheticPdf()], { type: "application/pdf" }),
  "synthetic.pdf",
);
const upload = await fetch(
  `${baseUrl}/api/v1/receipts/${receipt.id}/document`,
  {
    method: "POST",
    body: form,
  },
);
if (!upload.ok) throw new Error(`Upload failed with ${upload.status}`);

let document;
for (let attempt = 0; attempt < 60; attempt += 1) {
  const response = await fetch(
    `${baseUrl}/api/v1/receipts/${receipt.id}/document`,
  );
  if (!response.ok) throw new Error("Document status fetch failed");
  document = await response.json();
  if (document.normalizationStatus === "complete") break;
  if (document.normalizationStatus === "failed")
    throw new Error(`Normalization failed: ${document.normalizationError}`);
  await new Promise((resolve) => setTimeout(resolve, 250));
}
if (document?.normalizationStatus !== "complete" || document.pages.length !== 2)
  throw new Error("Two-page normalization did not complete");
for (const [index, page] of document.pages.entries()) {
  if (page.pageNumber !== index + 1 || page.totalPages !== 2)
    throw new Error("Normalized page order is invalid");
  const response = await fetch(`${baseUrl}${page.imageUrl}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!response.ok || bytes[0] !== 0x89 || bytes[1] !== 0x50)
    throw new Error("Normalized page is not a served PNG");
}
