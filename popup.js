const $ = (id) => document.getElementById(id);
const ACCOUNT_BUNDLE_SESSION_KEY = 'autoOauthAccountBundle';
const fields = {
  cpaUrl: $('cpa-url'), cpaManagementKey: $('cpa-key'), sub2apiUrl: $('sub2api-url'),
  sub2apiEmail: $('sub2api-email'), sub2apiPassword: $('sub2api-password'), sub2apiGroupName: $('sub2api-group'),
  sub2apiProxyName: $('sub2api-proxy'), sub2apiPriority: $('sub2api-priority'), sub2apiAccountName: $('sub2api-account-name'), openaiEmail: $('openai-email'),
  openaiPassword: $('openai-password'),
};
function configFromForm() {
  return Object.fromEntries(Object.entries(fields).map(([key, element]) => [key, element.type === 'checkbox' ? element.checked : element.value.trim()]));
}

function applyConfig(config) {
  for (const [key, element] of Object.entries(fields)) {
    if (config[key] !== undefined) element[element.type === 'checkbox' ? 'checked' : 'value'] = config[key];
  }
}

function renderStatus(status = {}) {
  const element = $('status');
  element.textContent = status.message || '等待开始授权。';
  element.className = `status status-${status.type || 'idle'}`;
}

async function saveConfig() {
  await chrome.runtime.sendMessage({ type: 'SAVE_CONFIG', payload: configFromForm() });
}

function parseOpenAiAccountBundle(rawValue) {
  const raw = String(rawValue || '').trim();
  const separator = raw.match(/([^\w\s])\1{1,}/)?.[0];
  if (!separator) return null;

  const parts = raw.split(separator).map((part) => part.trim()).filter(Boolean);
  const emailIndex = parts.findIndex((part) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(part));
  if (emailIndex < 0 || !parts[emailIndex + 1]) return null;

  return {
    email: parts[emailIndex],
    password: parts[emailIndex + 1],
    twoFactorUrl: findHttpsUrl(parts.slice(emailIndex + 2).join(separator)),
  };
}

function findHttpsUrl(rawValue) {
  const raw = String(rawValue || '').trim();
  const separator = raw.match(/([^\w\s])\1{1,}/)?.[0];
  const parts = separator ? raw.split(separator) : [raw];
  const isolatedUrl = parts
    .map((part) => part.trim().match(/^https:\/\/[^\s]+$/i)?.[0] || '')
    .find(Boolean);
  return isolatedUrl || raw.match(/https:\/\/[^\s<>'"]+/i)?.[0] || '';
}

let openedTwoFactorUrl = '';

function renderTwoFactorLink(url = '') {
  const link = $('two-factor-link');
  const wrap = $('two-factor-link-wrap');
  if (!url) {
    link.removeAttribute('data-url');
    link.href = '#';
    wrap.hidden = true;
    return;
  }
  link.dataset.url = url;
  link.href = url;
  wrap.hidden = false;
}

async function openTwoFactorUrl(url, force = false) {
  if (!url || (!force && url === openedTwoFactorUrl)) return;
  const result = await chrome.runtime.sendMessage({
    type: 'OPEN_TWO_FACTOR_URL',
    payload: { url },
  });
  if (result?.error) throw new Error(result.error);
  openedTwoFactorUrl = url;
}

async function applyOpenAiAccountBundle(manual = false) {
  const rawBundle = $('openai-account-bundle').value;
  renderTwoFactorLink(findHttpsUrl(rawBundle));
  const bundle = parseOpenAiAccountBundle(rawBundle);
  if (!bundle) {
    if (manual) throw new Error('未识别到有效的邮箱和密码格式。');
    return;
  }
  renderTwoFactorLink(bundle.twoFactorUrl);
  fields.openaiEmail.value = bundle.email;
  fields.openaiPassword.value = bundle.password;
  await saveConfig();

  await openTwoFactorUrl(bundle.twoFactorUrl, manual);
}

async function refresh() {
  const state = await chrome.runtime.sendMessage({ type: 'GET_VIEW_STATE' });
  applyConfig(state.config);
  const bundleStorage = await chrome.storage.session.get(ACCOUNT_BUNDLE_SESSION_KEY);
  const savedBundle = String(bundleStorage[ACCOUNT_BUNDLE_SESSION_KEY] || '');
  if (savedBundle && !$('openai-account-bundle').value) $('openai-account-bundle').value = savedBundle;
  renderTwoFactorLink(findHttpsUrl($('openai-account-bundle').value));
  if (!state.run && state.status?.type !== 'idle') {
    await chrome.runtime.sendMessage({ type: 'CLEAR_STATUS' });
    renderStatus({ type: 'idle', message: '等待开始授权。' });
    return;
  }
  renderStatus(state.status);
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes.autoOauthStatus?.newValue) return;
  renderStatus(changes.autoOauthStatus.newValue);
});

$('oauth-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const start = $('start');
  start.disabled = true;
  try {
    await saveConfig();
    const result = await chrome.runtime.sendMessage({ type: 'START_AUTHORIZATION' });
    if (result?.error) throw new Error(result.error);
    renderStatus({ type: 'waiting', message: '授权处理中。' });
  } catch (error) {
    renderStatus({ type: 'error', message: error.message || '无法开始授权。' });
  } finally {
    start.disabled = false;
  }
});

$('clear-status').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'CLEAR_STATUS' });
  renderStatus();
});

$('openai-account-bundle').addEventListener('input', () => {
  const value = $('openai-account-bundle').value;
  if (value) chrome.storage.session.set({ [ACCOUNT_BUNDLE_SESSION_KEY]: value });
  else chrome.storage.session.remove(ACCOUNT_BUNDLE_SESSION_KEY);
  renderTwoFactorLink(findHttpsUrl(value));
});

$('parse-account').addEventListener('click', () => {
  applyOpenAiAccountBundle(true).catch((error) => {
    renderStatus({ type: 'error', message: error.message || '无法解析账号信息。' });
  });
});

$('two-factor-link').addEventListener('click', (event) => {
  event.preventDefault();
  openTwoFactorUrl(event.currentTarget.dataset.url, true).catch((error) => {
    renderStatus({ type: 'error', message: error.message || '无法打开 2FA 地址。' });
  });
});

async function storeOneTimeCode() {
  const input = $('one-time-code');
  const code = input.value.replace(/\s+/g, '');
  if (code.length < 4) {
    return false;
  }
  try {
    const result = await chrome.runtime.sendMessage({ type: 'FILL_ONE_TIME_CODE', payload: { code } });
    if (result?.error) throw new Error(result.error);
    renderStatus({ type: 'waiting', message: '验证码已暂存，检测到授权页验证码输入框时将自动填写。' });
    return true;
  } catch (error) {
    renderStatus({ type: 'error', message: error.message || '无法填入验证码。' });
    return false;
  }
}

$('one-time-code').value = '';
$('one-time-code').addEventListener('change', () => {
  storeOneTimeCode().catch((error) => {
    renderStatus({ type: 'error', message: error.message || '无法暂存验证码。' });
  });
});

$('one-time-code').addEventListener('blur', async () => {
  try {
    if (!await storeOneTimeCode()) return;
    const result = await chrome.runtime.sendMessage({ type: 'CLOSE_TWO_FACTOR_TABS' });
    if (result?.error) renderStatus({ type: 'error', message: result.error });
  } catch (error) {
    renderStatus({ type: 'error', message: error.message || '无法关闭 2FA 页面。' });
  }
});

refresh().catch((error) => renderStatus({ type: 'error', message: error.message || '无法读取配置。' }));
