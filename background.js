const CONFIG_KEY = 'autoOauthConfig';
const RUN_KEY = 'autoOauthRun';
const STATUS_KEY = 'autoOauthStatus';
const ONE_TIME_CODE_KEY = 'autoOauthPendingOneTimeCode';
const TWO_FACTOR_TAB_IDS_KEY = 'autoOauthPendingTwoFactorTabIds';
const PENDING_ORIGIN_TAB_KEY = 'autoOauthPendingOriginTab';
const MANAGEMENT_REQUEST_TIMEOUT_MS = 90000;

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((error) => {
  console.warn('无法设置侧边栏图标点击行为：', error);
});

const DEFAULT_CONFIG = Object.freeze({
  cpaUrl: '',
  cpaManagementKey: '',
  sub2apiUrl: '',
  sub2apiEmail: '',
  sub2apiPassword: '',
  sub2apiGroupName: 'codex',
  sub2apiProxyName: '',
  sub2apiPriority: '1',
  sub2apiAccountName: '',
  openaiEmail: '',
  openaiPassword: '',
});

function clean(value = '') {
  return String(value || '').trim();
}

function accountNameForDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function redactError(error, secrets = []) {
  let message = clean(error?.message || error) || '未知错误。';
  for (const secret of secrets) {
    const normalized = clean(secret);
    if (normalized) message = message.split(normalized).join('[已隐藏]');
  }
  return message.replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [已隐藏]').slice(0, 800);
}

function normalizeUrl(value, fallbackPath = '') {
  const raw = clean(value);
  if (!raw) throw new Error('请先填写服务地址。');
  const parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  if (fallbackPath && (!parsed.pathname || parsed.pathname === '/')) {
    parsed.pathname = fallbackPath;
  }
  parsed.hash = '';
  return parsed;
}

function callbackFromUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  if (!['localhost', '127.0.0.1'].includes(parsed.hostname) || parsed.pathname !== '/auth/callback') {
    throw new Error('只接受 localhost 或 127.0.0.1 的 /auth/callback 回调。');
  }
  const code = clean(parsed.searchParams.get('code'));
  const state = clean(parsed.searchParams.get('state'));
  if (!code || !state) throw new Error('OAuth 回调缺少 code 或 state。');
  return { url: parsed.toString(), code, state };
}

function stateFromAuthUrl(authUrl) {
  try {
    return clean(new URL(authUrl).searchParams.get('state'));
  } catch {
    return '';
  }
}

async function getConfig() {
  const stored = await chrome.storage.local.get(CONFIG_KEY);
  return { ...DEFAULT_CONFIG, ...(stored[CONFIG_KEY] || {}) };
}

async function setStatus(type, message, extra = {}) {
  const status = { type, message, updatedAt: Date.now(), ...extra };
  await chrome.storage.local.set({ [STATUS_KEY]: status });
  return status;
}

async function closeTwoFactorTabs(returnToOrigin = false) {
  const stored = await chrome.storage.local.get([RUN_KEY, TWO_FACTOR_TAB_IDS_KEY, PENDING_ORIGIN_TAB_KEY]);
  const run = stored[RUN_KEY];
  const tabIds = Array.isArray(run?.twoFactorTabIds)
    ? run.twoFactorTabIds
    : (Array.isArray(stored[TWO_FACTOR_TAB_IDS_KEY]) ? stored[TWO_FACTOR_TAB_IDS_KEY] : []);
  await Promise.all(tabIds
    .filter((tabId) => Number.isInteger(tabId))
    .map((tabId) => chrome.tabs.remove(tabId).catch(() => {})));

  const originTabId = Number.isInteger(run?.originTabId)
    ? run.originTabId
    : (Number.isInteger(stored[PENDING_ORIGIN_TAB_KEY]?.id) ? stored[PENDING_ORIGIN_TAB_KEY].id : null);
  if (run) {
    run.twoFactorTabIds = [];
    await chrome.storage.local.set({ [RUN_KEY]: run });
  }
  await chrome.storage.local.set({ [TWO_FACTOR_TAB_IDS_KEY]: [], [PENDING_ORIGIN_TAB_KEY]: null });
  if (returnToOrigin && originTabId) {
    await chrome.tabs.update(originTabId, { active: true }).catch(() => {});
  }
}

async function requestJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || MANAGEMENT_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: options.method || 'GET',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        ...(options.headers || {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (payload && typeof payload === 'object' && Object.hasOwn(payload, 'code')) {
      if (Number(payload.code) === 0) return payload.data;
      throw new Error(clean(payload.message || payload.detail || payload.error) || `请求失败（HTTP ${response.status}）。`);
    }
    if (!response.ok) {
      throw new Error(clean(payload?.message || payload?.detail || payload?.error) || `请求失败（HTTP ${response.status}）。`);
    }
    return payload;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('请求超时，请检查地址和网络后重试。');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function requestCpaAuthUrl(config) {
  const managementKey = clean(config.cpaManagementKey);
  if (!managementKey) throw new Error('请填写 CPA 管理密钥。');
  const origin = normalizeUrl(config.cpaUrl).origin;
  const result = await requestJson(`${origin}/v0/management/codex-auth-url`, {
    headers: {
      Authorization: `Bearer ${managementKey}`,
      'X-Management-Key': managementKey,
    },
  });
  const authUrl = clean(result?.url || result?.auth_url || result?.authUrl || result?.data?.url || result?.data?.auth_url);
  if (!/^https?:\/\//i.test(authUrl)) throw new Error('CPA 未返回有效的 OAuth 授权地址。');
  return { authUrl, oauthState: clean(result?.state || result?.auth_state || result?.authState) || stateFromAuthUrl(authUrl), origin };
}

async function loginSub2Api(config) {
  const email = clean(config.sub2apiEmail);
  const password = String(config.sub2apiPassword || '');
  if (!email || !password) throw new Error('请填写 SUB2API 管理员邮箱和密码。');
  const origin = normalizeUrl(config.sub2apiUrl, '/admin/accounts').origin;
  const result = await requestJson(`${origin}/api/v1/auth/login`, {
    method: 'POST',
    body: { email, password },
  });
  const token = clean(result?.access_token || result?.accessToken);
  if (!token) throw new Error('SUB2API 登录响应缺少 access_token。');
  return { origin, token };
}

function parseGroupNames(value) {
  const unique = new Set();
  for (const item of String(value || 'codex').split(/[\r\n,，;；]+/)) {
    const name = clean(item);
    if (name) unique.add(name.toLowerCase());
  }
  return [...unique];
}

async function resolveSub2ApiGroups(origin, token, groupNames) {
  const groups = await requestJson(`${origin}/api/v1/admin/groups/all`, { token });
  const wanted = parseGroupNames(groupNames);
  const matched = wanted.map((name) => (Array.isArray(groups) ? groups : []).find((group) => (
    clean(group?.name).toLowerCase() === name && (!group.platform || clean(group.platform).toLowerCase() === 'openai')
  ))).filter(Boolean);
  if (matched.length !== wanted.length) {
    const matchedNames = new Set(matched.map((group) => clean(group.name).toLowerCase()));
    throw new Error(`SUB2API 中找不到分组：${wanted.filter((name) => !matchedNames.has(name)).join('、')}。`);
  }
  return matched;
}

async function resolveProxyId(origin, token, proxyName) {
  const name = clean(proxyName);
  if (!name) return null;
  const proxies = await requestJson(`${origin}/api/v1/admin/proxies/all?with_count=true`, { token });
  const proxy = (Array.isArray(proxies) ? proxies : []).find((item) => clean(item?.name).toLowerCase() === name.toLowerCase());
  if (!proxy?.id) throw new Error(`SUB2API 中找不到代理：${name}。`);
  return Number(proxy.id);
}

async function requestSub2ApiAuthUrl(config) {
  const { origin, token } = await loginSub2Api(config);
  const groups = await resolveSub2ApiGroups(origin, token, config.sub2apiGroupName);
  const proxyId = await resolveProxyId(origin, token, config.sub2apiProxyName);
  const result = await requestJson(`${origin}/api/v1/admin/openai/generate-auth-url`, {
    method: 'POST',
    token,
    body: {
      redirect_uri: 'http://localhost:1455/auth/callback',
      ...(proxyId ? { proxy_id: proxyId } : {}),
    },
  });
  const authUrl = clean(result?.auth_url || result?.authUrl);
  const sessionId = clean(result?.session_id || result?.sessionId);
  if (!/^https?:\/\//i.test(authUrl) || !sessionId) throw new Error('SUB2API 未返回完整的 auth_url 或 session_id。');
  return {
    authUrl,
    oauthState: clean(result?.state) || stateFromAuthUrl(authUrl),
    sessionId,
    groupIds: groups.map((group) => Number(group.id)).filter(Number.isSafeInteger),
    proxyId,
  };
}

function resolveAuthorizationTarget(config) {
  const hasCpaConfig = Boolean(clean(config.cpaUrl) || clean(config.cpaManagementKey));
  if (hasCpaConfig) return 'cpa';

  const hasSub2ApiConfig = Boolean(
    clean(config.sub2apiUrl)
    || clean(config.sub2apiEmail)
    || String(config.sub2apiPassword || '')
  );
  if (hasSub2ApiConfig) return 'sub2api';
  throw new Error('请填写 CPA 或 SUB2API 配置后再开始授权。');
}

async function startAuthorization() {
  const [config, activeTabs, pendingStorage] = await Promise.all([
    getConfig(),
    chrome.tabs.query({ active: true, lastFocusedWindow: true }),
    chrome.storage.local.get([TWO_FACTOR_TAB_IDS_KEY, PENDING_ORIGIN_TAB_KEY]),
  ]);
  const originTab = activeTabs[0];
  const pendingOriginTab = pendingStorage[PENDING_ORIGIN_TAB_KEY];
  const resolvedOriginTabId = Number.isInteger(pendingOriginTab?.id)
    ? pendingOriginTab.id
    : (Number.isInteger(originTab?.id) ? originTab.id : null);
  const resolvedOriginWindowId = Number.isInteger(pendingOriginTab?.windowId)
    ? pendingOriginTab.windowId
    : (Number.isInteger(originTab?.windowId) ? originTab.windowId : null);
  const pendingTwoFactorTabIds = Array.isArray(pendingStorage[TWO_FACTOR_TAB_IDS_KEY])
    ? pendingStorage[TWO_FACTOR_TAB_IDS_KEY].filter((id) => Number.isInteger(id))
    : [];
  await setStatus('working', '正在请求 OAuth 授权地址...');
  const target = resolveAuthorizationTarget(config);
  const auth = target === 'cpa' ? await requestCpaAuthUrl(config) : await requestSub2ApiAuthUrl(config);
  const tab = await chrome.tabs.create({ url: auth.authUrl, active: true });
  const latestPending = await chrome.storage.local.get(TWO_FACTOR_TAB_IDS_KEY);
  const latestPendingTwoFactorTabIds = Array.isArray(latestPending[TWO_FACTOR_TAB_IDS_KEY])
    ? latestPending[TWO_FACTOR_TAB_IDS_KEY].filter((id) => Number.isInteger(id))
    : [];
  const run = {
    target,
    tabId: tab.id,
    originTabId: resolvedOriginTabId,
    originWindowId: resolvedOriginWindowId,
    twoFactorTabIds: [...new Set([...pendingTwoFactorTabIds, ...latestPendingTwoFactorTabIds])],
    oauthState: auth.oauthState,
    origin: auth.origin || null,
    sessionId: auth.sessionId || null,
    groupIds: auth.groupIds || [],
    proxyId: auth.proxyId || null,
    startedAt: Date.now(),
  };
  await chrome.storage.local.set({
    [RUN_KEY]: run,
    [TWO_FACTOR_TAB_IDS_KEY]: [],
    [PENDING_ORIGIN_TAB_KEY]: null,
  });
  await setStatus('waiting', '授权处理中。', { target });
  schedulePageAutomation(tab.id);
  return { run };
}

function schedulePageAutomation(tabId) {
  setTimeout(async () => {
    const [config, stored] = await Promise.all([getConfig(), chrome.storage.local.get(RUN_KEY)]);
    const run = stored[RUN_KEY];
    if (!run || run.tabId !== tabId) return;
    chrome.tabs.sendMessage(tabId, {
      type: 'AUTO_OAUTH_FILL_AND_CONFIRM',
      payload: { email: config.openaiEmail, password: config.openaiPassword },
    }).catch(() => {});
  }, 700);
}

function credentialsFromExchange(data) {
  const credentials = {};
  for (const key of ['access_token', 'refresh_token', 'id_token', 'expires_at', 'email', 'chatgpt_account_id', 'chatgpt_user_id', 'organization_id', 'plan_type', 'client_id']) {
    if (data?.[key] !== undefined && data[key] !== null && data[key] !== '') credentials[key] = data[key];
  }
  if (!credentials.access_token) throw new Error('SUB2API 交换授权码后未返回 access_token。');
  return credentials;
}

async function submitCpaCallback(config, run, callback) {
  if (!clean(config.cpaManagementKey)) throw new Error('CPA 管理密钥不存在，请重新填写后重试。');
  const origin = run.origin || normalizeUrl(config.cpaUrl).origin;
  const result = await requestJson(`${origin}/v0/management/oauth-callback`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.cpaManagementKey}`,
      'X-Management-Key': config.cpaManagementKey,
    },
    body: { provider: 'codex', redirect_url: callback.url },
  });
  return clean(result?.message || result?.status_message) || 'CPA 已成功提交 OAuth 回调。';
}

async function submitSub2ApiCallback(config, run, callback) {
  if (!run.sessionId) throw new Error('SUB2API 授权会话不存在，请重新开始。');
  const { origin, token } = await loginSub2Api(config);
  const proxyId = run.proxyId || await resolveProxyId(origin, token, config.sub2apiProxyName);
  const exchange = await requestJson(`${origin}/api/v1/admin/openai/exchange-code`, {
    method: 'POST',
    token,
    body: { session_id: run.sessionId, code: callback.code, state: callback.state, ...(proxyId ? { proxy_id: proxyId } : {}) },
  });
  const priority = Number(config.sub2apiPriority || 1);
  if (!Number.isSafeInteger(priority) || priority < 1) throw new Error('SUB2API 账号优先级必须是大于等于 1 的整数。');
  const groupIds = run.groupIds.length ? run.groupIds : (await resolveSub2ApiGroups(origin, token, config.sub2apiGroupName)).map((group) => Number(group.id));
  const credentials = credentialsFromExchange(exchange);
  const name = clean(config.sub2apiAccountName) || accountNameForDate();
  const account = await requestJson(`${origin}/api/v1/admin/accounts`, {
    method: 'POST',
    token,
    body: {
      name,
      notes: '',
      platform: 'openai',
      type: 'oauth',
      credentials,
      concurrency: 1,
      priority,
      rate_multiplier: 1,
      group_ids: groupIds,
      auto_pause_on_expired: true,
      ...(proxyId ? { proxy_id: proxyId } : {}),
      ...(exchange?.email || exchange?.name ? { extra: Object.fromEntries(Object.entries({ email: exchange?.email, name: exchange?.name }).filter(([, value]) => clean(value))) } : {}),
    },
  });
  return `SUB2API OAuth 账号已创建：#${account?.id || 'unknown'}。`;
}

async function finishAuthorization(callbackUrl, tabId) {
  const stored = await chrome.storage.local.get(RUN_KEY);
  const run = stored[RUN_KEY];
  const callback = callbackFromUrl(callbackUrl);
  if (!run || run.finalizing) return;
  if (run.oauthState && run.oauthState !== callback.state) {
    // A localhost callback from another application is unrelated to this authorization.
    return;
  }
  run.finalizing = true;
  await chrome.storage.local.set({ [RUN_KEY]: run });
  const twoFactorTabIds = Array.isArray(run.twoFactorTabIds) ? run.twoFactorTabIds : [];
  await Promise.all(twoFactorTabIds
    .filter((twoFactorTabId) => Number.isInteger(twoFactorTabId) && twoFactorTabId !== tabId)
    .map((twoFactorTabId) => chrome.tabs.remove(twoFactorTabId).catch(() => {})));
  run.twoFactorTabIds = [];
  await chrome.storage.local.set({ [RUN_KEY]: run, [TWO_FACTOR_TAB_IDS_KEY]: [] });
  const config = await getConfig();
  await setStatus('working', '已收到 OAuth 回调，正在提交目标平台...');
  try {
    const message = run.target === 'cpa'
      ? await submitCpaCallback(config, run, callback)
      : await submitSub2ApiCallback(config, run, callback);
    await chrome.storage.local.remove(RUN_KEY);
    await setStatus('success', message);
    if (tabId && tabId !== run.originTabId) {
      await chrome.tabs.remove(tabId).catch(() => {});
    }
    if (run.originTabId) {
      await chrome.tabs.update(run.originTabId, { active: true }).catch(() => {});
    }
  } catch (error) {
    run.finalizing = false;
    await chrome.storage.local.set({ [RUN_KEY]: run });
    await setStatus('error', redactError(error, [config.cpaManagementKey, config.sub2apiPassword, config.openaiPassword]));
  }
}

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  let callback;
  try {
    callback = callbackFromUrl(details.url);
  } catch {
    return;
  }
  finishAuthorization(callback.url, details.tabId).catch(async (error) => {
    await setStatus('error', redactError(error));
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) {
    try {
      const callback = callbackFromUrl(changeInfo.url);
      finishAuthorization(callback.url, tabId).catch(async (error) => {
        await setStatus('error', redactError(error));
      });
    } catch {
      // Non-callback navigation; continue with OAuth page automation below.
    }
  }
  if (changeInfo.status === 'complete' || changeInfo.url) schedulePageAutomation(tabId);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case 'GET_VIEW_STATE': {
        const [config, stored] = await Promise.all([getConfig(), chrome.storage.local.get([STATUS_KEY, RUN_KEY])]);
        return { config, status: stored[STATUS_KEY] || { type: 'idle', message: '等待开始授权。' }, run: stored[RUN_KEY] || null };
      }
      case 'SAVE_CONFIG': {
        const config = { ...DEFAULT_CONFIG, ...(message.payload || {}) };
        await chrome.storage.local.set({ [CONFIG_KEY]: config });
        return { ok: true };
      }
      case 'START_AUTHORIZATION':
        return await startAuthorization();
      case 'OPEN_TWO_FACTOR_URL': {
        const url = String(message.payload?.url || '').trim();
        let parsed;
        try {
          parsed = new URL(url);
        } catch {
          throw new Error('2FA 地址格式无效。');
        }
        if (parsed.protocol !== 'https:') throw new Error('2FA 地址必须使用 HTTPS。');
        const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        const tab = await chrome.tabs.create({ url: parsed.toString(), active: true });
        if (Number.isInteger(tab.id)) {
          const stored = await chrome.storage.local.get([RUN_KEY, TWO_FACTOR_TAB_IDS_KEY, PENDING_ORIGIN_TAB_KEY]);
          const run = stored[RUN_KEY];
          if (run) {
            run.twoFactorTabIds = [...new Set([...(run.twoFactorTabIds || []), tab.id])];
            await chrome.storage.local.set({ [RUN_KEY]: run });
          } else {
            const pending = Array.isArray(stored[TWO_FACTOR_TAB_IDS_KEY]) ? stored[TWO_FACTOR_TAB_IDS_KEY] : [];
            await chrome.storage.local.set({
              [TWO_FACTOR_TAB_IDS_KEY]: [...new Set([...pending, tab.id])],
              [PENDING_ORIGIN_TAB_KEY]: stored[PENDING_ORIGIN_TAB_KEY]
                || (Number.isInteger(activeTab?.id)
                  ? { id: activeTab.id, windowId: activeTab.windowId }
                  : null),
            });
          }
        }
        return { ok: true };
      }
      case 'CLOSE_TWO_FACTOR_TABS':
        await closeTwoFactorTabs(true);
        return { ok: true };
      case 'FILL_ONE_TIME_CODE': {
        const code = String(message.payload?.code || '').replace(/\s+/g, '');
        if (!code) throw new Error('一次性验证码不能为空。');
        await chrome.storage.session.set({ [ONE_TIME_CODE_KEY]: code });
        const stored = await chrome.storage.local.get(RUN_KEY);
        const authorizationTabId = stored[RUN_KEY]?.tabId;
        if (Number.isInteger(authorizationTabId)) {
          chrome.tabs.sendMessage(authorizationTabId, { type: 'AUTO_OAUTH_RETRY_ONE_TIME_CODE' }).catch(() => {});
        }
        return { ok: true };
      }
      case 'GET_PENDING_ONE_TIME_CODE': {
        const stored = await chrome.storage.session.get(ONE_TIME_CODE_KEY);
        return { code: String(stored[ONE_TIME_CODE_KEY] || '') };
      }
      case 'CONSUME_ONE_TIME_CODE':
        await chrome.storage.session.remove(ONE_TIME_CODE_KEY);
        return { ok: true };
      case 'CLEAR_STATUS':
        await setStatus('idle', '等待开始授权。');
        return { ok: true };
      default:
        throw new Error('不支持的请求。');
    }
  })().then(sendResponse).catch(async (error) => {
    const config = await getConfig();
    const messageText = redactError(error, [config.cpaManagementKey, config.sub2apiPassword, config.openaiPassword]);
    await setStatus('error', messageText);
    sendResponse({ error: messageText });
  });
  return true;
});
