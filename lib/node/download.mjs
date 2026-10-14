// download.mjs — 带停滞超时、重试和进度回调的 HTTP 下载，只依赖 Node 内置 fetch。
//
// 超时按“多久没收到新字节”算，不是总时长：慢链路上一个 15MB 的文件可能要爬二十分钟，
// 只要字节还在进来就不该被判成卡死；真正的卡死（连接挂住、对端不再发）才会被中止并重试。
//
// 重试只针对「再试一次可能就好」的失败：网络错误、停滞、5xx、408、429。
// 404 这类说明地址本身有问题，重试没有意义，立刻失败。
// 内容完整性不在这里管：服务器声明了长度却中途断开，fetch 自己会抛错（已在 Node 22/24 上验证）；
// 内容对不对由调用方用哈希判定。

const httpError = (status) => Object.assign(new Error(`HTTP ${status}`), { status });
const retryable = (error) => !error.status || error.status >= 500 || error.status === 408 || error.status === 429;
// fetch 把真正的原因藏在 cause 里（ENOTFOUND、ECONNRESET…），外层只有 “fetch failed”。
const reasonOf = (error) => (error.cause?.code ? `${error.message}（${error.cause.code}）` : error.message);
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function attemptOnce(url, stallMs, onProgress) {
  const controller = new AbortController();
  let timer;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new Error(`${stallMs / 1000} 秒没有收到数据`)), stallMs);
  };
  arm();
  try {
    const res = await fetch(url, { redirect: 'follow', signal: controller.signal });
    if (!res.ok) {
      res.body?.cancel().catch(() => {});
      throw httpError(res.status);
    }
    // content-length 只用来算进度。带 content-encoding 时它是压缩后的大小，
    // 而 fetch 交给我们的是解压后的字节，两者不能比。
    const length = Number(res.headers.get('content-length'));
    const encoded = (res.headers.get('content-encoding') || 'identity') !== 'identity';
    const total = length > 0 && !encoded ? length : null;
    const chunks = [];
    let received = 0;
    for await (const chunk of res.body) {
      chunks.push(chunk);
      received += chunk.length;
      arm();
      onProgress?.({ received, total });
    }
    const body = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.length;
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {string} url
 * @param {object} [opts]
 * @param {number} [opts.stallMs]   这么久没收到任何字节就中止这次尝试
 * @param {number} [opts.retries]   首次失败后最多再试几次
 * @param {number} [opts.backoffMs] 第一次重试前的等待，之后每次翻倍
 * @param {(p: {received: number, total: number|null}) => void} [opts.onProgress] received 是当次尝试的累计字节
 * @param {(r: {attempt: number, retries: number, delayMs: number, reason: string}) => void} [opts.onRetry]
 * @returns {Promise<Uint8Array>}
 */
export async function download(url, { stallMs = 30_000, retries = 3, backoffMs = 1000, onProgress, onRetry } = {}) {
  new URL(url); // 地址本身不合法就立刻抛，别进重试
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await attemptOnce(url, stallMs, onProgress);
    } catch (error) {
      if (attempt >= retries || !retryable(error)) {
        throw Object.assign(new Error(`${url} → ${reasonOf(error)}`, { cause: error }), { status: error.status });
      }
      const delayMs = backoffMs * 2 ** attempt;
      onRetry?.({ attempt: attempt + 1, retries, delayMs, reason: reasonOf(error) });
      await sleep(delayMs);
    }
  }
}

const mb = (bytes) => (bytes / 1e6).toFixed(1);

function formatDuration(seconds) {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))} 秒`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} 分钟`;
  return `${(seconds / 3600).toFixed(1)} 小时`;
}

/** 一行进度文本：已收/总量、百分比、平均速度、剩余时间；总量未知时只给已收和速度。 */
export function formatProgress({ label, received, total, elapsedMs }) {
  const parts = [label];
  parts.push(total
    ? `${mb(received)} / ${mb(total)} MB  ${Math.floor((received * 100) / total)}%` // 先乘后除：先除再乘会因浮点误差少 1%
    : `${mb(received)} MB`);
  const bytesPerSecond = elapsedMs >= 1000 ? received / (elapsedMs / 1000) : 0; // 不足 1 秒时速度不稳，不显示
  if (bytesPerSecond > 0) {
    parts.push(bytesPerSecond >= 1e6 ? `${(bytesPerSecond / 1e6).toFixed(1)} MB/s` : `${(bytesPerSecond / 1e3).toFixed(1)} KB/s`);
    if (total) parts.push(`剩余约 ${formatDuration((total - received) / bytesPerSecond)}`);
  }
  return parts.join('  ');
}
