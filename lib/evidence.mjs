// evidence.mjs — 统一 Inspector / run.json 的安全事件台账。

const SECRET_KEY = /(authorization|api[-_]?key|token|cookie|secret|password)/i;

function shortBinary(value) {
  if (value instanceof Uint8Array) return `<Uint8Array ${value.byteLength}B>`;
  if (value instanceof ArrayBuffer) return `<ArrayBuffer ${value.byteLength}B>`;
  if (ArrayBuffer.isView(value)) return `<${value.constructor?.name || 'TypedArray'} ${value.byteLength}B>`;
  return null;
}

export function redactEvidence(value, { depth = 0, maxDepth = 6 } = {}) {
  const binary = shortBinary(value);
  if (binary) return binary;
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length > 8_000 ? `${value.slice(0, 8_000)}…<truncated>` : value;
  if (depth >= maxDepth) return '<max-depth>';
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => redactEvidence(v, { depth: depth + 1, maxDepth }));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, child] of Object.entries(value).slice(0, 200)) {
      out[key] = SECRET_KEY.test(key) ? '<redacted>' : redactEvidence(child, { depth: depth + 1, maxDepth });
    }
    return out;
  }
  return String(value);
}

export function createEvidenceLedger({ now = () => Date.now(), maxEntries = 4000 } = {}) {
  const startedAt = now();
  const entries = [];
  let seq = 0;
  const record = (kind, detail = {}, lane = null) => {
    const at = now();
    const item = {
      seq: ++seq,
      at,
      offsetMs: Math.max(0, at - startedAt),
      kind: String(kind),
      lane: lane == null ? null : String(lane),
      detail: redactEvidence(detail),
    };
    entries.push(item);
    if (entries.length > maxEntries) entries.splice(0, entries.length - maxEntries);
    return item;
  };
  return {
    startedAt,
    entries,
    record,
    clear() { entries.length = 0; seq = 0; },
    snapshot() { return entries.map((entry) => ({ ...entry, detail: redactEvidence(entry.detail) })); },
  };
}

/** 包住宿主能力方法，记录调用、结果与异常；返回新对象，不改原实现。 */
export function instrumentCapabilities(capabilities, { ledger, lane } = {}) {
  if (!ledger || typeof ledger.record !== 'function') throw new TypeError('instrumentCapabilities 需要 ledger');
  const out = {};
  for (const [namespace, methods] of Object.entries(capabilities || {})) {
    out[namespace] = {};
    for (const [method, fn] of Object.entries(methods || {})) {
      out[namespace][method] = async (...args) => {
        const started = ledger.record('capability.call', { namespace, method, args }, lane);
        try {
          const value = await fn(...args);
          ledger.record('capability.result', { callSeq: started.seq, namespace, method, value }, lane);
          return value;
        } catch (error) {
          ledger.record('capability.error', {
            callSeq: started.seq, namespace, method,
            error: { name: error?.name || 'Error', message: error?.message || String(error) },
          }, lane);
          throw error;
        }
      };
    }
  }
  return out;
}
