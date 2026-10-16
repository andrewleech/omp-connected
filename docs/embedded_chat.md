# Embedding a Collab session

A `/s/` link displays one session's full Collab guest without the rest of the hub dashboard. Use **Copy share link** on a control-shared session, then place that URL in an iframe on your page:

```html
<iframe
  src="https://<hub-host>:<port>/s/?host=<host-id>&i=<instance-id>&sid=<session-id>&cwd=<working-directory>&label=<session-label>"
  title="Live agent session"
  allow="clipboard-write"
></iframe>
```

Use the copied URL rather than assembling query parameters by hand. To make a reusable link for a session that may not be running yet, use `/s/?host=<host-id>&label=<session-label>&cwd=<working-directory>`. The page resolves the session on each load and starts it if no matching session exists. Encode query values with `URLSearchParams` if constructing a URL programmatically.

Set the embedding page's Content Security Policy `frame-src` to the exact hub origin, for example `frame-src https://<hub-host>:<port>`. The hub page handles its own API and relay connections; those origins do not need to be added to the embedding page's `connect-src`. The iframe needs enough height for the guest, and its parent can preserve it while hiding/showing the surrounding drawer.

A share URL is not an access-control mechanism. It contains no secret, and anyone who can reach the hub can get control access to the referenced session, including sending prompts and invoking its tools. Restrict network access to the hub accordingly. Do not embed it in a page available to people who should not be able to control that session.

The `/s/` wrapper sends `{ type: "ompc:close-chat" }` to its parent with `postMessage` when it receives an Escape key that the guest did not handle. The message uses target origin `*` because the parent origin is not known to the hub. Validate both `event.origin` against the exact hub origin and `event.source` against the wrapper iframe's `contentWindow` before closing a UI element:

```js
window.addEventListener("message", (event) => {
  if (
    event.origin !== "https://<hub-host>:<port>" ||
    event.source !== chatFrame.contentWindow ||
    event.data?.type !== "ompc:close-chat"
  ) return;
  closeChat();
});
```

Only handle the wrapper's message. The nested Collab guest is a different frame and must not be allowed to close the parent's UI directly. `postMessage` is only a UI signal, not an authorization mechanism.
