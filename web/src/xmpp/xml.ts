// Tiny element builder. Never build XML by string concatenation: the DOM escapes text/attrs.
const doc = document.implementation.createDocument(null, null, null);

export type XmlChild = Element | string;

// Pass xmlns only where the namespace changes; children inherit it on the wire. MongooseIM ignores RSM children that carry attributes.
export function xmlEl(
  name: string,
  attrs: Record<string, string> = {},
  children: XmlChild[] = [],
): Element {
  const el = doc.createElementNS(attrs.xmlns ?? null, name);
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, v);
  }
  for (const c of children) {
    el.appendChild(typeof c === "string" ? doc.createTextNode(c) : c);
  }
  return el;
}
