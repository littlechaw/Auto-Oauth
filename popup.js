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
  const labeledMatch = raw.match(/(?:电子邮件|邮件|邮箱|e-?mail)\s*[:：]\s*(\S+)\s+(?:密码|password|pass)\s*[:：]\s*(\S+)/i);
  if (labeledMatch) return createOpenAiAccountBundle(labeledMatch[1], labeledMatch[2]);

  const separator = raw.match(/([^\w\s])\1{1,}/)?.[0];
  if (!separator) return null;

  const [email, password, twoFactorAddress = ''] = raw.split(separator).map((part) => part.trim());
  return createOpenAiAccountBundle(email, password, twoFactorAddress);
}

function createOpenAiAccountBundle(email, password, twoFactorAddress = '') {
  // 兼容聊天记录或文档中为避免被识别而写成的 \@ 邮箱形式。
  const normalizedEmail = String(email || '').trim().replace(/\\@/g, '@');
  const normalizedPassword = String(password || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) || !normalizedPassword) return null;

  return {
    email: normalizedEmail,
    password: normalizedPassword,
    twoFactorUrl: isHttpsUrl(twoFactorAddress) ? twoFactorAddress : '',
  };
}

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function setTwoFactorUrl(url) {
  if (!url) return;
  const input = $('two-factor-url');
  const openButton = $('open-two-factor-url');
  input.value = url;
  openButton.disabled = !url;
}

async function openTwoFactorUrl(url) {
  if (!url) return;
  const result = await chrome.runtime.sendMessage({
    type: 'OPEN_TWO_FACTOR_URL',
    payload: { url },
  });
  if (result?.error) throw new Error(result.error);
}

async function applyOpenAiAccountBundle(manual = false) {
  const bundle = parseOpenAiAccountBundle($('openai-account-bundle').value);
  if (!bundle) {
    if (manual) throw new Error('未识别到有效的邮箱和密码格式。');
    return;
  }
  setTwoFactorUrl(bundle.twoFactorUrl);
  fields.openaiEmail.value = bundle.email;
  fields.openaiPassword.value = bundle.password;
  await saveConfig();
}

async function refresh() {
  const state = await chrome.runtime.sendMessage({ type: 'GET_VIEW_STATE' });
  applyConfig(state.config);
  const bundleStorage = await chrome.storage.session.get(ACCOUNT_BUNDLE_SESSION_KEY);
  const savedBundle = String(bundleStorage[ACCOUNT_BUNDLE_SESSION_KEY] || '');
  if (savedBundle && !$('openai-account-bundle').value) $('openai-account-bundle').value = savedBundle;
  setTwoFactorUrl(parseOpenAiAccountBundle($('openai-account-bundle').value)?.twoFactorUrl);
  if (!state.run && state.status?.type !== 'idle') {
    await chrome.runtime.sendMessage({ type: 'CLEAR_STATUS' });
    renderStatus({ type: 'idle', message: '等待开始授权。' });
    return;
  }
  renderStatus(state.status);
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes.autoOauthStatus?.newValue) return;
  const status = changes.autoOauthStatus.newValue;
  if (status.oneTimeCodeRejected) $('one-time-code').value = '';
  renderStatus(status);
});

async function startAuthorization(target) {
  const buttons = [$('start-cpa'), $('start-sub')];
  buttons.forEach((button) => { button.disabled = true; });
  const targetName = target === 'cpa' ? 'CPA' : 'SUB';
  try {
    await saveConfig();
    const result = await chrome.runtime.sendMessage({ type: 'START_AUTHORIZATION', payload: { target } });
    if (result?.error) throw new Error(result.error);
    renderStatus({ type: 'waiting', message: `${targetName} 授权处理中。` });
  } catch (error) {
    renderStatus({ type: 'error', message: error.message || `无法开始 ${targetName} 授权。` });
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
  }
}

$('start-cpa').addEventListener('click', () => startAuthorization('cpa'));
$('start-sub').addEventListener('click', () => startAuthorization('sub2api'));

$('clear-status').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'CLEAR_STATUS' });
  renderStatus();
});

$('openai-account-bundle').addEventListener('input', () => {
  const value = $('openai-account-bundle').value;
  if (value) chrome.storage.session.set({ [ACCOUNT_BUNDLE_SESSION_KEY]: value });
  else chrome.storage.session.remove(ACCOUNT_BUNDLE_SESSION_KEY);
  setTwoFactorUrl(parseOpenAiAccountBundle(value)?.twoFactorUrl);
});

$('parse-account').addEventListener('click', () => {
  applyOpenAiAccountBundle(true).catch((error) => {
    renderStatus({ type: 'error', message: error.message || '无法解析账号信息。' });
  });
});

$('two-factor-url').addEventListener('input', () => {
  $('open-two-factor-url').disabled = !$('two-factor-url').value.trim();
});

$('open-two-factor-url').addEventListener('click', () => {
  openTwoFactorUrl($('two-factor-url').value.trim()).catch((error) => {
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
