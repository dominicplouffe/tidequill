/** Word-level diff (Myers-ish LCS on tokens), small and dependency free. */

export type DiffOp = { type: "same" | "ins" | "del"; text: string };

function tokenize(s: string): string[] {
  return s.match(/\s+|[\p{L}\p{N}'’_-]+|[^\s\p{L}\p{N}]/gu) ?? [];
}

export function wordDiff(before: string, after: string): DiffOp[] {
  const a = tokenize(before);
  const b = tokenize(after);
  // Trim common prefix/suffix to keep the table small.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const ops: DiffOp[] = [];
  if (start) ops.push({ type: "same", text: a.slice(0, start).join("") });

  if (midA.length * midB.length > 250_000) {
    // Too big for a table: show as replace.
    if (midA.length) ops.push({ type: "del", text: midA.join("") });
    if (midB.length) ops.push({ type: "ins", text: midB.join("") });
  } else {
    const n = midA.length;
    const m = midB.length;
    const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = midA[i] === midB[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) {
        push(ops, "same", midA[i]!);
        i++;
        j++;
      } else if (j < m && (i >= n || dp[i]![j + 1]! >= dp[i + 1]![j]!)) {
        push(ops, "ins", midB[j]!);
        j++;
      } else {
        push(ops, "del", midA[i]!);
        i++;
      }
    }
  }
  if (endA < a.length) ops.push({ type: "same", text: a.slice(endA).join("") });
  return merge(ops);
}

function push(ops: DiffOp[], type: DiffOp["type"], text: string) {
  const last = ops[ops.length - 1];
  if (last && last.type === type) last.text += text;
  else ops.push({ type, text });
}

/** Merge adjacent runs of the same kind. */
function merge(ops: DiffOp[]): DiffOp[] {
  const out: DiffOp[] = [];
  for (const op of ops) {
    const prev = out[out.length - 1];
    if (prev && prev.type === op.type) prev.text += op.text;
    else out.push({ ...op });
  }
  return out;
}

/** Split markdown into paragraphs and diff only the ones that changed. */
export function paragraphDiff(before: string, after: string): { changed: boolean; ops: DiffOp[] }[] {
  const pa = before.split(/\n{2,}/);
  const pb = after.split(/\n{2,}/);
  const out: { changed: boolean; ops: DiffOp[] }[] = [];
  // LCS on paragraphs.
  const n = pa.length;
  const m = pb.length;
  if (n * m > 40_000) return [{ changed: true, ops: wordDiff(before, after) }];
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = pa[i] === pb[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  let i = 0;
  let j = 0;
  let pendingDel: string[] = [];
  let pendingIns: string[] = [];
  const flush = () => {
    while (pendingDel.length || pendingIns.length) {
      const d = pendingDel.shift();
      const s = pendingIns.shift();
      out.push({ changed: true, ops: wordDiff(d ?? "", s ?? "") });
    }
  };
  while (i < n || j < m) {
    if (i < n && j < m && pa[i] === pb[j]) {
      flush();
      out.push({ changed: false, ops: [{ type: "same", text: pa[i]! }] });
      i++;
      j++;
    } else if (j < m && (i >= n || dp[i]![j + 1]! >= dp[i + 1]![j]!)) {
      pendingIns.push(pb[j++]!);
    } else {
      pendingDel.push(pa[i++]!);
    }
  }
  flush();
  return out;
}
