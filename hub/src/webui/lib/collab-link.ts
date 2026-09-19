// Splits a brokered Collab link's URL fragment (the bearer capability) off
// and rebuilds it against this origin's vendored guest at /collab/. The
// capability must never enter the outer page's history or storage — only
// the guest's in-memory fragment. Ported unchanged from claude-net's
// predecessor (`collabFrameUrl`); logic verified correct in the original
// dashboard ticket's browser smoke test.

export function collabFrameUrl(link: string, origin: string): string {
  const fragmentOffset = link.indexOf("#");
  if (fragmentOffset < 0)
    throw new Error("Broker returned a Collab link without a fragment");
  const url = new URL("/collab/", origin);
  url.hash = link.slice(fragmentOffset + 1);
  return url.toString();
}