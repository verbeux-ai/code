/**
 * upload.js — upload a file to a file input on the active tab.
 *
 * P5 SCAFFOLD. This is a stub that documents the contract. The real
 * implementation uses chrome.scripting.executeScript to set the
 * input.files via DataTransfer, then dispatches a change event so
 * the page's own upload handler fires. That code lands in the same
 * PR that adds the file payload plumbing through the agent loop.
 *
 * Risk: `elevated`. File uploads can carry malware, exfiltrate
 * secrets, or bypass same-origin checks depending on the target.
 * evaluateToolPolicy forces `needsApproval` in every mode — Manual,
 * Auto, AND Skip. The `always` site grant does NOT bypass this
 * (elevated check runs before site grant check; see
 * evaluateToolPolicy.js:61-63).
 *
 * Why `risk: 'elevated'` not `'mutate'`:
 *   - The action is technically a mutate, but the blast radius is
 *     wider than a click: an upload can POST to any server the page
 *     points at, including cross-origin.
 *   - Surfacing it as elevated in the panel UI signals to the user
 *     "this leaves the page context" — which is the right heuristic.
 *
 * @param {{
 *   name: 'file_upload';
 *   selector: string;
 *   mimeType?: string;
 *   filename?: string;
 *   risk?: string;
 *   input?: string;
 * }} tool
 * @returns {Promise<never>} throws — contract-only stub
 */
export async function fileUpload(tool) {
  const selector = tool?.selector
  if (!selector || typeof selector !== 'string') {
    throw new Error('upload: missing selector')
  }
  const mimeType = typeof tool?.mimeType === 'string' ? tool.mimeType : 'application/octet-stream'
  const filename = typeof tool?.filename === 'string' ? tool.filename : 'upload.bin'

  // Contract-only stub. Real impl:
  //   1. read tool.payload (base64 or text) from a side-channel
  //   2. chrome.scripting.executeScript with func that:
  //        - finds the input by selector
  //        - constructs a File via new File([bytes], filename, { type })
  //        - wraps in DataTransfer
  //        - sets input.files = dt.files
  //        - dispatches change event
  //   3. return { selector, filename, mimeType, bytes }
  //
  // Payload plumbing from the agent loop is the missing piece —
  // we don't accept tool.payload yet because ToolCall.params is
  // intentionally bounded to small shapes.
  throw new Error(
    `upload: unsupported_in_p5_scaffold — contract only. ` +
    `selector=${selector} filename=${filename} mime=${mimeType}. ` +
    `Real impl lands when tool payload channel ships (P5.1).`,
  )
}