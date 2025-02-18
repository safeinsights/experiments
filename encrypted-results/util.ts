// Helper: Convert a PEM encoded string to an ArrayBuffer.
function pemToArrayBuffer(pem: string) {
  // Remove the PEM header, footer, and line breaks.
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  // Use atob in the browser, or Buffer in Node.js.
  if (typeof atob === "function") {
    const binaryStr = atob(b64);
    const len = binaryStr.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }
    return bytes.buffer;
  } else {
    return Buffer.from(b64, "base64").buffer;
  }
}

// Helper: Convert an ArrayBuffer to a hex string.
function arrayBufferToHex(buffer: ArrayBuffer) {
  const byteArray = new Uint8Array(buffer);
  return Array.from(byteArray)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
