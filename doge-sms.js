// doge-sms.js — DogeSMS 接码平台精简客户端
// 基于 DogeSMS REST API v1（https://api.dogesms.com/v1）。
// 功能与 hero-sms.js 对齐：余额、按国家查价、下单、轮询取码、取消订单。
(function attachDogeSmsClient(root, factory) {
  root.DogeSmsClient = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createDogeSmsClient() {
  const BASE_URL = 'https://api.dogesms.com/v1';
  // DogeSMS 的目录与下单接口使用不同的 OpenAI 服务编码。
  const CATALOG_SERVICE_CODE = 'openai-chatgpt';
  const SERVICE_CODE = 'openai';
  const SERVICE_LABEL = 'OpenAI';
  const MAX_PRICE_CENTS = 30;
  const REQUEST_TIMEOUT_MS = 20000;
  const POLL_TIMEOUT_MS = 180000;
  const POLL_INTERVAL_MS = 5000;

  // 国家候选池：与 HeroSMS 统一，默认美国、次英国。
  const COUNTRY_CANDIDATES = Object.freeze([
    { code: 'US', label: '美国' },
    { code: 'GB', label: '英国' },
    { code: 'VN', label: '越南' },
    { code: 'TH', label: '泰国' },
    { code: 'ID', label: '印度尼西亚' },
    { code: 'JP', label: '日本' },
    { code: 'DE', label: '德国' },
    { code: 'FR', label: '法国' },
  ]);

  function generateUUID() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  function extractErrorCode(payload) {
    if (!payload || typeof payload !== 'object') return '';
    if (typeof payload.error === 'string') return payload.error;
    if (payload.error && typeof payload.error === 'object') return payload.error.code || '';
    return '';
  }

  function extractErrorMessage(payload) {
    if (!payload || typeof payload !== 'object') return '';
    if (typeof payload.error === 'string') return payload.error;
    if (payload.error && typeof payload.error === 'object') return payload.error.message || '';
    return '';
  }

  function localizedReason(payload, status = '') {
    const code = extractErrorCode(payload);
    const message = extractErrorMessage(payload);
    const combined = `${code} ${message}`.trim();
    if (/API_KEY_MISSING|API_KEY_INVALID|API_KEY_REVOKED/i.test(combined)) return 'API Key 无效或已撤销';
    if (/INSUFFICIENT_BALANCE/i.test(combined)) return '余额不足';
    if (/WALLET_NOT_INITIALIZED/i.test(combined)) return '钱包未初始化，请先充值';
    if (/ACCOUNT_BANNED|EMAIL_NOT_VERIFIED|ACCOUNT_NOT_ACTIVE/i.test(combined)) return '账号状态异常';
    if (/SERVICE_NOT_AVAILABLE/i.test(combined)) return '当前服务/国家组合暂无库存';
    if (/PRICE_CHANGED/i.test(combined)) return '价格已变动，请重新查询价格后重试';
    if (/CANCEL_TOO_EARLY/i.test(combined)) return '下单后 2 分钟内不可取消，请稍后再试';
    if (/CANCEL_DENIED_RETRY_LATER/i.test(combined)) return '当前暂不允许取消，请数分钟后重试或等待自然过期退款';
    if (/ORDER_ALREADY_TERMINAL/i.test(combined)) return '订单已处于终态';
    if (/ORDER_NOT_FOUND/i.test(combined)) return '订单不存在';
    if (/ORDER_QUERY_NOT_AVAILABLE/i.test(combined)) return '订单查询已被禁用';
    if (/RATE_LIMITED|TOO_MANY_ACTIVE_ORDERS/i.test(combined)) return '请求过于频繁，请稍后重试';
    if (message) return `${message}${status ? ` (HTTP ${status})` : ''}`;
    if (code) return `${code}${status ? ` (HTTP ${status})` : ''}`;
    return status ? `请求失败（HTTP ${status}）` : '请求失败';
  }

  async function request(apiKey, path, options = {}) {
    if (!apiKey) throw new Error('DogeSMS API Key 缺失，请先填写 API Key。');
    const url = `${BASE_URL}${path}`;
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    };
    let result;
    try {
      result = await chrome.runtime.sendMessage({
        type: 'DOGESMS_REQUEST',
        payload: {
          url,
          method: options.method || 'GET',
          headers,
          body: options.body,
          timeoutMs: REQUEST_TIMEOUT_MS,
        },
      });
    } catch (error) {
      throw new Error(error?.message || 'DogeSMS 请求发送失败。');
    }
    if (result?.error) throw new Error(result.error);
    const text = String(result?.text || '');
    let payload = '';
    try { payload = text ? JSON.parse(text) : ''; } catch { payload = text; }
    if (!result?.ok) {
      const rawPreview = text.trim().slice(0, 240);
      const reason = localizedReason(payload, result?.status);
      const errorMessage = rawPreview ? `${reason} | 原始响应：${rawPreview}` : reason;
      const error = new Error(errorMessage);
      error.payload = payload;
      error.status = result?.status;
      throw error;
    }
    return payload;
  }

  function normalizeOrder(order) {
    if (!order || typeof order !== 'object') return null;
    return {
      orderId: String(order.id || ''),
      orderNo: String(order.order_no || ''),
      serviceCode: String(order.service_code || ''),
      countryCode: String(order.country_code || ''),
      status: String(order.status || ''),
      amountCents: Number(order.amount_cents ?? 0),
      currency: String(order.currency || 'USD'),
      phoneNumber: order.phone_number ? String(order.phone_number) : null,
      smsCode: order.sms_code ? String(order.sms_code) : null,
      smsContent: order.sms_content ? String(order.sms_content) : null,
      errorCode: order.error_code ? String(order.error_code) : null,
      errorMessage: order.error_message ? String(order.error_message) : null,
      createdAt: order.created_at || null,
      activatedAt: order.activated_at || null,
      completedAt: order.completed_at || null,
      expiredAt: order.expired_at || null,
      cancelledAt: order.cancelled_at || null,
    };
  }

  async function fetchBalance(apiKey) {
    const payload = await request(apiKey, '/balance');
    const balanceCents = payload?.data?.balance_cents;
    if (!Number.isFinite(Number(balanceCents))) {
      throw new Error('DogeSMS 查询余额失败：响应格式异常');
    }
    return {
      balanceCents: Number(balanceCents),
      currency: String(payload?.data?.currency || 'USD'),
    };
  }

  async function fetchCountryPrice(apiKey, country) {
    const payload = await request(apiKey, `/catalog/prices?country_code=${encodeURIComponent(country.code)}`);
    const items = Array.isArray(payload?.data) ? payload.data : [];
    const item = items.find((entry) => entry.service_code === CATALOG_SERVICE_CODE);
    if (!item) return null;
    const availableCount = Number(item.available_count ?? 0);
    if (availableCount <= 0) return null;
    return {
      country,
      priceCents: Number(item.price_cents),
      availableCount,
    };
  }

  async function createOrder(apiKey, country, maxPriceCents) {
    const body = {
      service_code: SERVICE_CODE,
      country_code: country.code,
    };
    if (Number.isFinite(maxPriceCents)) {
      body.max_price_cents = Math.max(0, Math.floor(maxPriceCents));
    }
    const payload = await request(apiKey, '/orders', {
      method: 'POST',
      headers: { 'Idempotency-Key': generateUUID() },
      body,
    });
    const order = normalizeOrder(payload?.data);
    if (!order?.orderId) throw new Error('DogeSMS 创建订单失败：响应中缺少订单 ID');
    return order;
  }

  async function fetchOrder(apiKey, orderId) {
    const payload = await request(apiKey, `/orders/${encodeURIComponent(orderId)}`);
    return normalizeOrder(payload?.data);
  }

  async function cancelOrder(apiKey, orderId) {
    const payload = await request(apiKey, `/orders/${encodeURIComponent(orderId)}/cancel`, { method: 'POST' });
    return normalizeOrder(payload?.data);
  }

  return {
    SERVICE_CODE,
    SERVICE_LABEL,
    MAX_PRICE_CENTS,
    COUNTRY_CANDIDATES,
    POLL_TIMEOUT_MS,
    POLL_INTERVAL_MS,
    fetchBalance,
    fetchCountryPrice,
    createOrder,
    fetchOrder,
    cancelOrder,
  };
});
