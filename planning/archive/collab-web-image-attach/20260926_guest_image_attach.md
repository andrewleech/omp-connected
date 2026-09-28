# Collab guest image attachments: design, reviews and verification

Date: 2026-09-28 (work done 2026-09-25 to 2026-09-26)
HEAD: a418691 (omp-connected); fork `collab-web-image-attach` at c67aca85c (pushed to the fork, no upstream PR)

This is the only record of the track. There was no roadmap or tickets; it was built, reviewed and fixed within one session, and this summarises that session's review and fix reports.

## What it does
The browser guest (`packages/collab-web`) can attach images to a prompt: pick them with the attach button, paste or drop them on the composer. Images go in the existing `prompt` frame as `{ t: "prompt", text, images }`; `images` is only sent when there is at least one. The host already accepted images on guest prompts, so the change is guest-only (plus the CHANGELOG entry). It is hidden and guarded when the share is view-only.

## Design
- **Frame budget.** A sealed guest frame is one binary WebSocket message: 4-byte peer header, 12-byte IV, ciphertext the length of the JSON, 16-byte tag. The omp-connected relay drops messages over 1 MiB (`maxPayloadLength`), and the host replicates the prompt back to guests under the same 1 MiB ceiling (`MAX_REPLICATED_PAYLOAD_BYTES` in `coding-agent/src/collab/replication-shrink.ts`). The guest gates each send at `PROMPT_FRAME_LIMIT_BYTES` = 1 MiB - 4096. The reserve keeps the host's `custom_message` echo (about 300 bytes plus the guest name around the same text and images) from being shrunk, which would show truncated base64 to every guest. `sealedPromptFrameBytes` computes the exact sealed size of the same object shape and key order `client.sendPrompt` sends.
- **Image fitting.** Images share an 850,000-character base64 budget (`PROMPT_IMAGE_BUDGET_BYTES`), leaving the rest of the frame for text and JSON. Each is downscaled to omp's 1568 px longest edge. Encoding order: the original bytes if the format is accepted as-is and already within the edge, then PNG at the fitted size for non-JPEG sources (screenshots stay lossless), then JPEG at qualities 0.85, 0.7, 0.55, 0.4 at each of the scales 1, 0.75, 0.5, 0.35. Files are fitted smallest first, each capped at an even share of what's left, so budget a small image doesn't use rolls over to the larger ones. Results keep the input order.
- **Memory.** Files are ordered by `file.size` and decoded one at a time. Each full-size bitmap is drawn once into a fitted canvas and closed straight away, and the canvas is released after encoding. Peak memory is one full decode plus one fitted canvas, so picking many phone photos doesn't hold hundreds of MB of pixels. `createImageBitmap` with resize options was not used: it needs the natural size first, which costs a full decode anyway, and older Safari ignores the resize options.
- **Text is required.** Image-only sends are refused, because the host always prepends a text block and providers such as Anthropic reject an empty one [INFERENCE in the review].
- **Paste rules.** A paste with non-empty `text/plain` is a text paste and attaches nothing: Office apps and file managers put a rendered image of the selection next to its text. The exception is text that is only an image address (`https:`, `data:` or `blob:` with no spaces), which is what Firefox's "Copy Image" puts next to the image. Images are read from `files`, falling back to `items`.
- **Unreadable files.** `addFiles` decodes a probe of each image as it is attached. Files that fail (SVG in Chromium, HEIC outside Safari, TIFF in Chrome) are named in the tray notice and never added. Send is disabled and the tray shows "checking images…" while probes run.
- **Drops.** Any drag carrying files gets `preventDefault`, with `dropEffect = "none"` when attaching is unavailable, so a drop during encoding can't navigate the tab to the image. There is no window-level drop guard.
- **Session changes.** `decidePromptSend` rechecks the snapshot after encoding and returns "session is read-only; prompt not sent" or "session disconnected; prompt not sent" instead of dropping the send silently.
- The remove button's hit area is 24x24 px (WCAG 2.2 SC 2.5.8) around an 18 px circle, with a `:focus-visible` outline.

## Reviews
1. First review: correct, no blockers (confidence 0.72). Two P2 findings: Office-style pastes attached a stray image next to the text, and every picked photo was decoded at full size at once (risk of iOS Safari killing the tab). Six P3 findings: drops during encoding navigated away, a silent no-op when the session changed mid-send, no headroom for the host echo, undecodable files accepted until send, an 18 px remove target, and tests that only covered markup and constants. It confirmed the frame-size arithmetic, object URL revocation and read-only guards.
2. All eight were fixed; the design section above describes the result.
3. Re-review: every finding fixed, one regression (P2). The text-paste rule stopped Firefox "Copy Image" pastes from attaching; fixed with the image-address exception and a test. There was no third review after that fix.

## Verification
- collab-web `check` and tests pass: 138 at c67aca85c, 158 on `ompc-fleet` with the tail-snapshot branch merged.
- Headless Chromium against a throwaway hub with a real `ompc` session, 2026-09-26: a pasted PNG attached and sent with a prompt; a paste with text plus an image attached nothing; a 4000x3000 noise PNG (48 MB) was sent as a 1568x1176 JPEG of about 580 KB of base64, and the host echoed it into the transcript.
- Not tested: Firefox and Safari, real clipboards (the pastes were synthetic `ClipboardEvent`s), mobile gallery picks, and drag and drop.

## Deployment
Live in the hub's Collab guest. `ompc-fleet` includes it through mbm (`.omp/mbm.toml`) as a fork-only branch, and the guest is built from that tree with `COLLAB_WEB_SRC`.
