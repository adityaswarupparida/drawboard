/**
 * Reads a JSON object while the model is still writing it, so edits can be
 * applied and the reply shown before the response is finished.
 *
 * Returns every fully written item of the top-level "ops" array (as raw JSON
 * text) and the "reply" string so far (decoded, possibly incomplete).
 */
export interface PartialScan {
  ops: string[];
  reply: string | null;
  replyDone: boolean;
}

export function scanPartial(buf: string): PartialScan {
  const ops: string[] = [];
  let reply: string | null = null;
  let replyDone = false;

  let depth = 0;
  let inString = false;
  let escape = false;
  let expectKey = false;
  let key = "";
  let lastKey = "";
  let stringStart = -1;
  let opsArrayDepth = -1; // depth at which the ops array's items live
  let itemStart = -1;
  let readingReply = false;
  let replyRaw = "";

  for (let i = 0; i < buf.length; i++) {
    const ch = buf[i]!;
    if (inString) {
      if (readingReply) replyRaw += ch;
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
        if (readingReply) {
          replyRaw = replyRaw.slice(0, -1); // drop closing quote
          readingReply = false;
          replyDone = true;
          reply = decode(replyRaw);
        } else if (expectKey && depth === 1) {
          key = buf.slice(stringStart + 1, i);
          lastKey = key;
          expectKey = false;
        }
      }
      continue;
    }
    switch (ch) {
      case '"':
        inString = true;
        stringStart = i;
        if (depth === 1 && !expectKey && lastKey === "reply") {
          readingReply = true;
          replyRaw = "";
        }
        break;
      case "{":
        depth++;
        if (depth === 1) expectKey = true;
        if (opsArrayDepth !== -1 && depth === opsArrayDepth + 1) itemStart = i;
        break;
      case "[":
        depth++;
        if (depth === 2 && lastKey === "ops") opsArrayDepth = 2;
        break;
      case "}":
        if (opsArrayDepth !== -1 && depth === opsArrayDepth + 1 && itemStart >= 0) {
          ops.push(buf.slice(itemStart, i + 1));
          itemStart = -1;
        }
        depth--;
        break;
      case "]":
        if (depth === opsArrayDepth) opsArrayDepth = -1;
        depth--;
        break;
      case ",":
        if (depth === 1) expectKey = true;
        break;
    }
  }
  if (readingReply) reply = decode(replyRaw);
  return { ops, reply, replyDone };
}

/** Decodes the body of a JSON string, tolerating a cut-off escape at the end. */
function decode(raw: string): string {
  let s = raw;
  // Trim a trailing partial escape such as `\` or `\u12`.
  const m = s.match(/\\(u[0-9a-fA-F]{0,3})?$/);
  if (m) s = s.slice(0, m.index);
  try {
    return JSON.parse(`"${s}"`) as string;
  } catch {
    return s.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
}
