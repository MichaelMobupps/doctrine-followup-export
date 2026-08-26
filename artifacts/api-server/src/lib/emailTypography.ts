/**
 * emailTypography.ts — font inheritance and Gmail-shaped body HTML.
 *
 * Two problems this fixes (2026-08-26, Sunil feedback):
 *
 * 1. FONT. gmailClient.ts hardcoded
 *      font-family: "Calibri Light", Calibri, sans-serif; font-size: 11pt
 *    on every follow-up. Calibri Light 11pt is Word/Outlook paste styling,
 *    it is not a web-safe face, and on a machine without Calibri it falls
 *    back to Carlito or a generic sans. The result is that a follow-up can
 *    render in a visibly different typeface from the very email it is
 *    replying to — the same person's messages in one thread set in two
 *    fonts, which a recipient notices without knowing why. The fix is to
 *    read the font off the message being replied to and reuse it, falling
 *    back to NO font declaration at all (which is what Gmail compose sends
 *    when you simply type) rather than to a guess.
 *
 * 2. SPACING. plainTextToHtml mapped every \n to a bare <br>, so a blank
 *    line became <br><br> and a real paragraph gap was impossible to
 *    express. buildBodyHtml emits the container/div shape Gmail compose
 *    itself produces, so a shaped body renders with proper gaps.
 *
 * The extraction half is pure and lives here so it can be unit-tested
 * without a Gmail client; gmailClient.ts owns the fetch.
 */

export interface InheritedFont {
  fontFamily?: string;
  fontSize?: string;
}

/**
 * Everything from a quoted-reply marker onward belongs to an older
 * message in the thread. Its styling is not what the message we are
 * replying to was composed in, so it is cut before any scanning.
 */
const QUOTE_MARKERS = [
  '<div class="gmail_quote',
  '<div class=3d"gmail_quote',
  "<blockquote",
  '<div id="appendonsend"',
  '<div id="divrplyfwdmsg"',
  "<hr",
];

function cutQuotedSection(html: string): string {
  const lower = html.toLowerCase();
  let end = html.length;
  for (const marker of QUOTE_MARKERS) {
    const idx = lower.indexOf(marker);
    if (idx >= 0 && idx < end) end = idx;
  }
  return html.slice(0, end);
}

/**
 * A font-family value we are willing to copy into our own outbound HTML.
 *
 * The source is another message's markup, so this is a strict allowlist
 * rather than a blocklist: letters, digits, spaces, commas, hyphens,
 * periods and quotes only. That admits every real stack
 * (`"Calibri Light", Calibri, sans-serif`, `Arial, Helvetica, sans-serif`)
 * and admits nothing that could close the attribute or smuggle in a
 * url()/expression() payload.
 */
function sanitizeFontFamily(raw: string): string | undefined {
  const value = raw.replace(/!important/gi, "").trim().replace(/[;,\s]+$/, "");
  if (!value || value.length > 160) return undefined;
  if (!/^[\p{L}\p{N} ,.'"-]+$/u.test(value)) return undefined;
  // Normalise double quotes to single so the value can never terminate the
  // style attribute we embed it in.
  return value.replace(/"/g, "'");
}

function sanitizeFontSize(raw: string): string | undefined {
  const value = raw.replace(/!important/gi, "").trim().replace(/[;,\s]+$/, "");
  const m = value.match(/^(\d{1,3}(?:\.\d{1,2})?)(pt|px|em|rem|%)$/i);
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  // Reject implausible sizes; a follow-up set in 2pt or 96pt is a bug in
  // the source message, not an inheritance worth honouring.
  if (unit === "pt" && (n < 6 || n > 24)) return undefined;
  if (unit === "px" && (n < 8 || n > 32)) return undefined;
  if ((unit === "em" || unit === "rem") && (n < 0.5 || n > 2.5)) return undefined;
  if (unit === "%" && (n < 50 || n > 250)) return undefined;
  return `${m[1]}${unit}`;
}

/**
 * Read the font the message being replied to was composed in.
 *
 * Takes the FIRST font-family and the FIRST font-size that appear in the
 * message's own (non-quoted) markup, whether they come from an inline
 * style attribute or a <style> rule. First-wins matches how a mail client
 * composes: the outermost container carries the chosen face and anything
 * deeper is an exception inside it (a signature, a link, a quoted line).
 *
 * Returns an empty object when the source declares no font — the correct
 * and common case for a message typed straight into Gmail, and the signal
 * for the caller to declare no font either.
 */
export function extractFontFromHtml(html: string | null | undefined): InheritedFont {
  if (!html) return {};
  const scope = cutQuotedSection(decodeQuotedPrintable(html));
  const out: InheritedFont = {};

  // Scan style ATTRIBUTE VALUES and <style> blocks rather than the raw
  // markup. Scanning the markup directly cannot see past the first quote
  // inside a declaration, which silently dropped every quoted font name —
  // and `"Calibri Light"` is exactly that shape, so the most common stack
  // in these threads was the one it could not read.
  for (const css of cssChunks(scope)) {
    if (!out.fontFamily) {
      const m = css.match(/font-family\s*:\s*([^;}]+)/i);
      if (m) {
        const family = sanitizeFontFamily(m[1]);
        if (family) out.fontFamily = family;
      }
    }
    if (!out.fontSize) {
      const m = css.match(/font-size\s*:\s*([^;}]+)/i);
      if (m) {
        const size = sanitizeFontSize(m[1]);
        if (size) out.fontSize = size;
      }
    }
    if (out.fontFamily && out.fontSize) break;
  }

  return out;
}

/**
 * Style attribute values and <style> block contents, in document order.
 * First-wins across this sequence matches how a mail client composes: the
 * outermost container carries the chosen face and anything deeper is an
 * exception inside it (a signature, a link, a quoted line).
 */
function cssChunks(scope: string): string[] {
  const re = /style\s*=\s*"([^"]*)"|style\s*=\s*'([^']*)'|<style[^>]*>([\s\S]*?)<\/style>/gi;
  const chunks: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(scope)) !== null) {
    chunks.push(m[1] ?? m[2] ?? m[3] ?? "");
    if (chunks.length >= 200) break;
  }
  return chunks;
}

/**
 * Undo quoted-printable when the part carried that transfer encoding, which
 * turns every "=" into "=3D" and wraps long lines with a trailing "=". A
 * style attribute reads as style=3D"..." in that form and would otherwise be
 * invisible to the scanner.
 */
function decodeQuotedPrintable(html: string): string {
  if (!html.includes("=3D") && !/=\r?\n/.test(html)) return html;
  return html.replace(/=\r?\n/g, "").replace(/=3D/gi, "=");
}

/**
 * Render an InheritedFont as a style attribute value. Empty string when
 * nothing was inherited, which the caller turns into no style attribute.
 */
export function fontStyleAttr(font: InheritedFont): string {
  const parts: string[] = [];
  if (font.fontFamily) parts.push(`font-family: ${font.fontFamily}`);
  if (font.fontSize) parts.push(`font-size: ${font.fontSize}`);
  return parts.length ? `${parts.join("; ")};` : "";
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Turn a shaped plain-text body into the markup Gmail compose produces.
 *
 * A blank line between blocks becomes `<div><br></div>` — a real paragraph
 * gap. A single newline inside a block becomes `<br>` — the tight break
 * you get from one press of Enter. The old builder could only ever produce
 * the second kind, which is why every follow-up shipped as an unbroken
 * slab.
 */
export function buildBodyHtml(text: string): string {
  const normalised = (text || "")
    .replace(/\\n/g, "\n")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!normalised) return "";

  const blocks = normalised.split(/\n{2,}/);
  const rendered: string[] = [];

  blocks.forEach((block, i) => {
    if (i > 0) rendered.push("<div><br></div>");
    const lines = block.split("\n");
    rendered.push(`<div>${lines.map((l) => escapeHtml(l)).join("<br>")}</div>`);
  });

  return rendered.join("");
}
