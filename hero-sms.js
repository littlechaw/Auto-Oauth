// hero-sms.js — HeroSMS 接码平台精简客户端
// 移植自 FlowPilot phone-sms/providers/hero-sms.js（sms-activate 兼容协议），
// 仅保留本扩展需要的：余额、按国家查价、下单（含 WRONG_MAX_PRICE 重试）、
// 轮询取码、订单状态（3=追加短信 / 6=完成 / 8=取消退款）。
(function attachHeroSmsClient(root, factory) {
  root.HeroSmsClient = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createHeroSmsClient() {
  const BASE_URL = 'https://hero-sms.com/stubs/handler_api.php';
  const SERVICE_CODE = 'dr'; // OpenAI
  const SERVICE_LABEL = 'OpenAI';
  const REQUEST_TIMEOUT_MS = 20000;
  const POLL_TIMEOUT_MS = 180000;
  const POLL_INTERVAL_MS = 5000;

  // 国家候选池：ID 与 FlowPilot COUNTRY_BY_PHONE_PREFIX 保持一致（平台已验证）。
  const COUNTRY_CANDIDATES = Object.freeze([
    { id: 187, label: '美国' },
    { id: 16, label: '英国' },
    { id: 10, label: '越南' },
    { id: 52, label: '泰国' },
    { id: 6, label: '印度尼西亚' },
    { id: 151, label: '日本' },
    { id: 43, label: '德国' },
    { id: 73, label: '法国' },
  ]);

  function parsePayload(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return '';
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try { return JSON.parse(trimmed); } catch { return trimmed; }
    }
    return trimmed;
  }

  function describePayload(raw) {
    if (typeof raw === 'string') return raw.trim();
    if (raw && typeof raw === 'object') {
      const direct = String(raw.message || raw.msg || raw.error || raw.title || raw.status || '').trim();
      if (direct) return direct;
      try { return JSON.stringify(raw); } catch { return String(raw); }
    }
    return String(raw || '').trim();
  }

  function normalizePrice(value) {
    const direct = Number(value);
    if (Number.isFinite(direct) && direct >= 0) return direct;
    const text = String(value ?? '').trim();
    if (!text) return null;
    const matched = text.match(/-?\d+(?:[.,]\d+)?/);
    if (!matched) return null;
    const parsed = Number(String(matched[0] || '').replace(',', '.'));
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }

  function buildUrl(query = {}) {
    const url = new URL(BASE_URL);
    Object.entries(query || {}).forEach(([key, value]) => {
      if (value === undefined || value === null || value === '') return;
      url.searchParams.set(key, String(value));
    });
    return url.toString();
  }

  async function fetchPayload(apiKey, query, actionLabel = 'HeroSMS request') {
    if (!apiKey) throw new Error('HeroSMS API Key 缺失，请先填写 API Key。');
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(buildUrl({ api_key: apiKey, ...query }), {
        method: 'GET',
        signal: controller.signal,
      });
      const text = await response.text();
      const payload = parsePayload(text);
      if (!response.ok) {
        const error = new Error(`${actionLabel}失败：${describePayload(payload) || response.status}`);
        error.payload = payload;
        throw error;
      }
      return payload;
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error(`${actionLabel}超时，请检查网络后重试。`);
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  function localizedReason(rawReason) {
    const text = describePayload(rawReason);
    if (/\bBAD_KEY\b|\bWRONG_KEY\b|\bINVALID_KEY\b/i.test(text)) return 'API Key 无效（BAD_KEY）';
    if (/\bNO_BALANCE\b|\bNOT_ENOUGH_BALANCE\b/i.test(text)) return '余额不足';
    if (/\bBANNED\b|\bACCOUNT_BANNED\b/i.test(text)) return '账号已被封禁';
    if (/\bNO_NUMBERS\b/i.test(text)) return '当前无可用号码';
    if (/\bEARLY_CANCEL_DENIED\b/i.test(text)) return '平台拒绝提前取消：下单后 2 分钟内不可取消（官方 SDK 定义），请稍后再试';
    return text || '未知错误';
  }

  async function fetchBalance(apiKey) {
    const payload = await fetchPayload(apiKey, { action: 'getBalance' }, 'HeroSMS 查询余额');
    const balance = Number(String(describePayload(payload)).replace(/^ACCESS_BALANCE:/i, '').trim());
    if (!Number.isFinite(balance)) throw new Error(`HeroSMS 查询余额失败：${describePayload(payload)}`);
    return balance;
  }

  // 从 getPrices 响应中递归收集可用价格（结构兼容 sms-activate 各版本）。
  function collectPriceCandidates(payload, candidates = []) {
    if (Array.isArray(payload)) {
      payload.forEach((entry) => collectPriceCandidates(entry, candidates));
      return candidates;
    }
    if (!payload || typeof payload !== 'object') return candidates;
    const cost = normalizePrice(payload.cost);
    if (cost !== null) {
      const count = normalizePrice(payload.count ?? payload.stock);
      if (count === null || count > 0) candidates.push(cost);
    }
    Object.entries(payload).forEach(([key, value]) => {
      const keyedPrice = normalizePrice(key);
      if (keyedPrice === null) return;
      if (value && typeof value === 'object') {
        const count = normalizePrice(value.count ?? value.stock);
        if (count === null || count > 0) candidates.push(keyedPrice);
        return;
      }
      if (Number.isFinite(Number(value)) && Number(value) > 0) candidates.push(keyedPrice);
    });
    Object.values(payload).forEach((value) => collectPriceCandidates(value, candidates));
    return candidates;
  }

  async function fetchCountryPrice(apiKey, country) {
    const payload = await fetchPayload(apiKey, {
      action: 'getPrices',
      service: SERVICE_CODE,
      country: country.id,
    }, `HeroSMS 查询${country.label}价格`);
    const candidates = collectPriceCandidates(payload, []);
    if (!candidates.length) return null;
    return { country, price: Math.min(...candidates) };
  }

  // 查询候选国家在 OpenAI 服务下的最低价，按价格升序返回（跳过无库存国家）。
  async function fetchCheapestCountries(apiKey) {
    const settled = await Promise.all(COUNTRY_CANDIDATES.map((country) => (
      fetchCountryPrice(apiKey, country).catch(() => null)
    )));
    return settled.filter(Boolean).sort((left, right) => left.price - right.price);
  }

  function extractWrongMaxPrice(payload) {
    if (payload && typeof payload === 'object') {
      const title = String(payload.title || '').trim();
      const minPrice = normalizePrice(payload.info?.min);
      if (/^WRONG_MAX_PRICE$/i.test(title) && minPrice !== null) return minPrice;
    }
    const text = describePayload(payload);
    const match = text.match(/\bWRONG_MAX_PRICE:(\d+(?:\.\d+)?)\b/i);
    return match ? normalizePrice(match[1]) : null;
  }

  function isTerminalError(payload) {
    return /\bNO_BALANCE\b|\bNOT_ENOUGH_BALANCE\b|\bBAD_KEY\b|\bINVALID_KEY\b|\bBANNED\b|\bACCOUNT_BANNED\b|\bWRONG_KEY\b/i.test(describePayload(payload));
  }

  async function requestActivation(apiKey, country, maxPrice) {
    let nextMaxPrice = maxPrice;
    let retriedWithUpdatedPrice = false;
    while (true) {
      let payload = null;
      try {
        payload = await fetchPayload(apiKey, {
          action: 'getNumber',
          service: SERVICE_CODE,
          country: country.id,
          maxPrice: nextMaxPrice,
          fixedPrice: 'true',
        }, `HeroSMS 获取${country.label}号码`);
      } catch (error) {
        const updatedMaxPrice = extractWrongMaxPrice(error?.payload || error?.message);
        if (nextMaxPrice !== null && !retriedWithUpdatedPrice && updatedMaxPrice !== null) {
          nextMaxPrice = updatedMaxPrice;
          retriedWithUpdatedPrice = true;
          continue;
        }
        throw new Error(`获取手机号失败：${localizedReason(error?.payload || error?.message)}`);
      }
      // 部分平台以 200 返回错误文本，成功路径同样处理。
      const updatedMaxPrice = extractWrongMaxPrice(payload);
      if (updatedMaxPrice !== null && nextMaxPrice !== null && !retriedWithUpdatedPrice) {
        nextMaxPrice = updatedMaxPrice;
        retriedWithUpdatedPrice = true;
        continue;
      }
      if (isTerminalError(payload)) throw new Error(`获取手机号失败：${localizedReason(payload)}`);
      return payload;
    }
  }

  function parseActivation(payload) {
    const text = describePayload(payload);
    const match = text.match(/^ACCESS_NUMBER:([^:]+):(.+)$/i);
    if (!match) return null;
    return {
      activationId: String(match[1] || '').trim(),
      phoneNumber: String(match[2] || '').trim(),
      serviceCode: SERVICE_CODE,
      serviceLabel: SERVICE_LABEL,
    };
  }

  // 按价格从低到高依次尝试下单；NO_NUMBERS 自动尝试下一档。
  async function acquireCheapestNumber(apiKey, countries) {
    let lastError = null;
    for (const entry of countries) {
      try {
        const payload = await requestActivation(apiKey, entry.country, entry.price);
        const activation = parseActivation(payload);
        if (activation) {
          return {
            ...activation,
            countryId: entry.country.id,
            countryLabel: entry.country.label,
            price: entry.price,
          };
        }
        lastError = new Error(`获取手机号失败：${describePayload(payload) || '空响应'}`);
      } catch (error) {
        lastError = error;
        if (!/无可用号码|NO_NUMBERS/i.test(lastError.message)) throw lastError;
      }
    }
    throw lastError || new Error('获取手机号失败：候选国家均无可用号码。');
  }

  // 针对指定国家查询价格并下单。
  async function acquireNumberForCountry(apiKey, country) {
    const priced = await fetchCountryPrice(apiKey, country);
    if (!priced) throw new Error(`${country.label} 当前无可用价格或库存，请切换国家或稍后重试。`);
    const payload = await requestActivation(apiKey, country, priced.price);
    const activation = parseActivation(payload);
    if (!activation) throw new Error(`获取手机号失败：${describePayload(payload) || '空响应'}`);
    return {
      ...activation,
      countryId: country.id,
      countryLabel: country.label,
      price: priced.price,
    };
  }

  function extractVerificationCode(rawCode) {
    const trimmed = String(rawCode || '').trim();
    if (!trimmed) return '';
    return trimmed.match(/\b(\d{4,8})\b/)?.[1] || '';
  }

  // 单次查询订单状态，返回 { code, text }。code 非空表示验证码已收到。
  async function fetchActivationStatus(apiKey, activationId) {
    const payload = await fetchPayload(apiKey, {
      action: 'getStatus',
      id: activationId,
    }, 'HeroSMS 查询短信状态');
    const text = describePayload(payload);
    const code = extractVerificationCode(text.match(/^STATUS_OK:(.+)$/i)?.[1] || '');
    if (/^STATUS_CANCEL$/i.test(text)) throw new Error('HeroSMS 订单在短信到达前已被取消。');
    if (!code && !/^STATUS_(OK|WAIT_CODE|WAIT_RETRY|WAIT_RESEND)(?::.+)?$/i.test(text)) {
      throw new Error(`查询短信状态失败：${localizedReason(text)}`);
    }
    return { code, text };
  }

  async function setActivationStatus(apiKey, activationId, status) {
    let payload = null;
    try {
      payload = await fetchPayload(apiKey, {
        action: 'setStatus',
        id: activationId,
        status: Math.floor(Number(status) || 0),
      }, 'HeroSMS 更新订单状态');
    } catch (error) {
      throw new Error(`更新订单状态失败：${localizedReason(error?.payload || error?.message)}`);
    }
    const text = describePayload(payload);
    // 部分平台以 200 返回拒绝信息，同样转成中文错误。
    if (/\bEARLY_CANCEL_DENIED\b/i.test(text) || isTerminalError(text)) {
      throw new Error(`更新订单状态失败：${localizedReason(text)}`);
    }
    return text;
  }

  return {
    SERVICE_CODE,
    SERVICE_LABEL,
    COUNTRY_CANDIDATES,
    POLL_TIMEOUT_MS,
    POLL_INTERVAL_MS,
    fetchBalance,
    fetchCheapestCountries,
    acquireCheapestNumber,
    acquireNumberForCountry,
    fetchActivationStatus,
    setActivationStatus,
    // 状态码：3 = 请求再次发送短信，6 = 完成订单，8 = 取消并退款。
    STATUS_REQUEST_ADDITIONAL: 3,
    STATUS_FINISH: 6,
    STATUS_CANCEL: 8,
  };
});
