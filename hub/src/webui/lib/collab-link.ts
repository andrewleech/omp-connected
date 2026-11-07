// Splits a brokered Collab link's URL fragment (the bearer capability) off
// and rebuilds it against this origin's vendored guest at /collab/. The
// capability must never enter the outer page's history or storage — only
// the guest's in-memory fragment.

/**
 * `label` (the ompc session name) rides along as a `label` query parameter,
 * outside the fragment: the guest puts it in the message references it copies.
 */
export function collabFrameUrl(
  link: string,
  origin: string,
  label?: string,
): string {
  const fragmentOffset = link.indexOf("#");
  if (fragmentOffset < 0)
    throw new Error("Broker returned a Collab link without a fragment");
  const url = new URL("/collab/", origin);
  if (label) url.searchParams.set("label", label);
  url.hash = link.slice(fragmentOffset + 1);
  return url.toString();
}
