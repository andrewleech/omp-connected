# Collab whole-form Ask

- Written: 2026-11-17
- omp-connected baseline: `4bb86379e39b92cd33684cc8ec405842c2ada84f`
- Fleet source baseline: `7bdc42e3db06bb4ac3e752672a98742e4883b47f`
- Upstream RPC PR inspected: [#18646](https://github.com/can1357/oh-my-pi/pull/18646), head `25b43b43e8d13b3d59502a5fcad931ff74943676`, open at writing
- ompweb inspected: [ompweb-dev/ompweb](https://github.com/ompweb-dev/ompweb), main `e99dac06ef9483ccddf24123e478a67909ed4918`

## Goal and scope

A control guest sees and answers the complete Ask form, including explanatory text, in one dialog, with the same answers, defaults and validation as the terminal. The terminal remains independently usable. Implement in the OMP fork's Collab host, wire and browser guest. The hub and relay remain opaque to the form payload. Do not edit vendored or built guest files by hand.

The fleet source's `ExtensionUIController.showFormDialog` parses the HTML and races the local form against `#runGuestForm`; the guest path calls `fieldQuestions` and sends per-field requests, losing surrounding blocks. The RPC PR installs a different `formDialog` in RPC mode. Merging it alone does not change Collab.

## Prior work and decisions

The fleet's `parseHtmlForm` uses the lightweight `pi-utils/dom` parser, not the browser DOM. It lives under `pi-tui`, which `collab-web` does not currently depend on. Verify browser bundling and choose the smallest suitable package boundary before sharing it. The fleet guest renders prompts as React elements and its clipboard HTML-to-Markdown converter already strips active content and restricts URLs; that converter is not an Ask renderer. The fleet wire uses protocol v4 with v3 fallback, and its UI request variants are currently select and editor, so an added form variant needs an explicit compatibility decision.

- [ompweb-dev/oh-my-pi commit ba5fb31](https://github.com/ompweb-dev/oh-my-pi/commit/ba5fb31cca69db8db0829466f426fe255e3d9cbd) proposed context text for field-by-field RPC prompts, not a full form. Do not base the Collab implementation on this patch.
- [ompweb's form renderer](https://github.com/ompweb-dev/ompweb/blob/e99dac06ef9483ccddf24123e478a67909ed4918/components/ExtensionDialog.tsx) parses inertly and reconstructs React controls, explicitly selecting elements and attributes; it does not inject raw HTML. It implements Other, defaults and typed submission. It is a behaviour and test reference, not a dependency. Current ompweb uses its own runner/channel rather than the RPC protocol; do not treat its current wire contract as #18646's.
- Reuse OMP's existing parsed form model and helpers if they can be used in the browser bundle without pulling in unsuitable dependencies. Prefer rendering that model with the guest's existing React conventions. If that is not viable, assess the existing guest sanitizer or an established dependency first. Define only the rendering boundary required for supported Ask form elements; do not build multiple overlapping allowlists or a new general-purpose HTML sanitisation framework. Model-generated markup is untrusted: never directly inject active raw HTML into the guest. Ensure scripts, event handlers, active URLs and form navigation cannot execute; preserve supported content and controls rather than silently displaying a partial form.
- Follow the upstream Ask form contract and #18646's submitted-value semantics, not its RPC transport. Keep Collab framing and access checks separate. A temporary local validation implementation must have one named owner, clear tests and an explicit removal path, not a second permanent policy.
- Context-only per-field prompts are not the target. Existing per-field handling may serve older peers as described below; do not add a separate interim context feature unless its need is separately established.

## Work plan

### 1. Revalidate and settle the shared contract

Fetch current `upstream/main`, check the status and final diff of #18646 and ompweb's renderer. Record revisions and a dated revalidation here before implementation. Inspect the real fleet source, active feature branches, current Collab wire and handshake, form parser exports, supported HTML, rendering and test conventions. Reproduce the screenshot with a deterministic form containing paragraph text, a recommended radio answer and multiple fields. Document differences between the pinned fleet release and upstream.

On a new feature branch from `upstream/main`, design the Collab request and reply around an entire form and named submitted values, cancellation and timeout semantics. Match the current upstream form contract, including Other, hidden inputs, disabled options, array/scalar values, numeric values, constraints and defaults; preserve structured text and supported inline content. Check frame size limits and behaviour for large forms and images, including whether existing form/image support can be carried intact. Explicitly document unsupported content or a size failure rather than silently dropping it. Do not assume RPC frame limits apply to Collab.

### 2. Host, protocol and coexistence

Use Collab's established protocol/version or capability mechanism after checking what is actually available; define an explicit negotiation or safe fallback if required. A new host must not send an unknown blocking form request to an old guest. Old hosts must continue to work with a new guest through their existing requests. With an old or unavailable guest, retain the existing field-by-field path or leave the terminal dialog available, as the observed capabilities permit. Do not claim contextual parity for legacy field-by-field clients.

Send form requests only to writable guests; preserve the existing local/guest race, one winning answer, late-response rejection, abort and cancellation. Cover reconnect/replay, multiple guests, disconnect, host timeout and timeout-disabled plan mode without leaving a pending request that can block the terminal. Validate guest-supplied responses on the host against the original parsed form. View-only peers must not be able to answer. Use existing Collab lifecycle and security mechanisms; do not add a second channel or route through the hub RPC.

### 3. Browser guest

Implement one form UI in the existing guest dialog surface, using existing styles, input patterns and lifecycle. Preserve paragraph/section order, options, preselection, checkbox state, Other, text inputs, validation feedback and accessibility. Show the complete form at desktop and phone sizes, with keyboard and touch access. Submit the whole form using the same named-value contract as the host; local validation should permit corrections, while host validation remains authoritative. Reuse the existing parser/model or one established safe rendering boundary as decided in step 1; test malicious HTML and unsafe URLs without expanding scope into a general HTML renderer.

### 4. Verify behaviour and compatibility

Add focused regression tests following OMP's host, wire and guest conventions. Cover the original missing paragraph, multiple fields, ordered context, defaults, radio/checkbox and Other, required and invalid inputs, hidden/disabled values, typed results and supported markup. Exercise the host's rejection of malformed or unauthorised answers. Test cancellation, timeout and plan mode, simultaneous local and guest answers, disconnect/reconnect and at least old-host/new-guest and new-host/old-guest combinations. Check message-size and unsupported-content outcomes. Verify in a real browser against a real Collab host at desktop and mobile viewport, including an embedded dashboard session, and record actual results. Do not substitute component snapshots for the end-to-end interaction.

### 5. Upstream reconciliation and fleet integration

Do not merge the unmerged RPC PR into the feature branch or cherry-pick its commits just to obtain a base. Before coding and again before upstream submission, check whether #18646 merged:

- If merged, rebase the Collab branch onto current upstream and use the merged form-data contract and shared helpers. If response validation remains private inside RPC mode, extract the transport-independent validation into a shared module in the feature branch, migrate both RPC and Collab callers, and remove the duplicate; preserve RPC's existing error and timeout behaviour with tests. If upstream has already extracted it, use that instead.
- If still open, implement only the Collab-specific path and isolate any missing shared validation behind one transport-neutral helper, based on existing OMP form primitives and compatible with the PR contract. Do not change RPC or import its private functions. When #18646 later merges, rebase and reconcile the implementations: choose one shared validator, migrate both callers and delete the redundant implementation and tests that merely duplicate it. Compare observable semantics and retain distinct transport tests. Record upstream PR/commit and reconciliation status here; this is required follow-through, not an indefinite compatibility shim.
- If the PR changes contract or is closed, re-evaluate against actual upstream before integration; do not assume an unmerged wire format is stable.

Keep one independently upstreamable feature branch off `upstream/main`; never commit on `ompc-fleet`. Follow the local runbook for isolated release refresh, integration and building the guest from the same source tree. Resolve release backport differences explicitly; do not bypass pinned carry or merge checks. Update upstream docs and changelog with the final behaviour. Review the feature and integration result before any publication or deployment. Deployment is a separate operation and existing sessions require restart to pick up a new host binary.

## Acceptance

- A control guest sees the explanatory paragraph and complete form in the same Ask, can choose and submit, and the agent receives the corresponding values.
- Form controls, supported content, defaults and validation agree with the current OMP contract; invalid responses are not accepted and untrusted markup cannot execute.
- Local terminal, cancellation, timeout, access checks, multiple guests, reconnect and mixed-version behaviour meet the lifecycle requirements above, backed by focused tests and browser evidence.
- No duplicate shared validator remains after #18646 integration. If that PR is still open at delivery, the temporary helper and explicit reconciliation record remain identifiable.
- The final feature branch, test results, upstream status, build source and any unverified scenarios are recorded here with dated revisions.
