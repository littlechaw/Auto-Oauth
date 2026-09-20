const $ = (id) => document.getElementById(id);
const ACCOUNT_BUNDLE_SESSION_KEY = 'autoOauthAccountBundle';
const ACCOUNT_SEPARATOR_SESSION_KEY = 'autoOauthAccountSeparator';
const fields = {
  cpaUrl: $('cpa-url'), cpaManagementKey: $('cpa-key'), cpaAdminKey: $('cpa-admin-key'), sub2apiUrl: $('sub2api-url'),
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

// ---------- 授权进度 ----------
const AUTH_PHASE_KEY = 'autoOauthPhase';
const AUTH_PHASE_STEPS = { request: 0, account: 0, email: 0, password: 0, code: 1, phone: 2, consent: 3, submit: 4, done: 5 };
let currentPhase = '';
let currentStatusType = 'idle';

function renderAuthSteps() {
  const list = $('auth-steps');
  const index = AUTH_PHASE_STEPS[currentPhase];
  if (index === undefined || currentStatusType === 'idle') {
    list.classList.add('hidden');
    return;
  }
  list.classList.remove('hidden');
  [...list.children].forEach((item, itemIndex) => {
    if (itemIndex < index) item.className = 'is-done';
    else if (itemIndex > index) item.className = '';
    else item.className = currentStatusType === 'error' ? 'is-error' : 'is-current';
  });
}

function renderStatus(status = {}) {
  const element = $('status');
  element.textContent = status.message || '等待开始授权。';
  element.className = `status status-${status.type || 'idle'}`;
  currentStatusType = status.type || 'idle';
  renderAuthSteps();
}

// ---------- 分区切换 ----------
function showTab(name) {
  const isRun = name === 'run';
  $('panel-run').classList.toggle('hidden', !isRun);
  $('panel-settings').classList.toggle('hidden', isRun);
  $('tab-run').classList.toggle('is-active', isRun);
  $('tab-settings').classList.toggle('is-active', !isRun);
  $('tab-run').setAttribute('aria-selected', String(isRun));
  $('tab-settings').setAttribute('aria-selected', String(!isRun));
}

$('tab-run').addEventListener('click', () => showTab('run'));
$('tab-settings').addEventListener('click', () => showTab('settings'));

// ---------- 账号摘要 ----------
function currentAccountEmail() {
  return parseOpenAiAccountBundle($('openai-account-bundle').value, $('account-separator').value)?.email || fields.openaiEmail.value.trim();
}

function renderAccountSummary() {
  const email = currentAccountEmail();
  const element = $('account-summary-email');
  element.textContent = email || '未设置账号';
  element.classList.toggle('is-empty', !email);
}

function setAccountEditorOpen(open) {
  $('account-editor').classList.toggle('hidden', !open);
  $('toggle-account').textContent = open ? '收起' : '改';
}

$('toggle-account').addEventListener('click', () => {
  setAccountEditorOpen($('account-editor').classList.contains('hidden'));
});

async function saveConfig() {
  await chrome.runtime.sendMessage({ type: 'SAVE_CONFIG', payload: configFromForm() });
}

function parseOpenAiAccountBundle(rawValue, customSeparator = '') {
  const raw = String(rawValue || '').trim();
  const customSep = String(customSeparator || '').trim();

  if (customSep) {
    const parts = raw.split(customSep).map((part) => part.trim());
    if (parts.length < 2) return null;
    const [email, password, twoFactorAddress = ''] = parts;
    return createOpenAiAccountBundle(email, password, twoFactorAddress);
  }

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
  const bundle = parseOpenAiAccountBundle($('openai-account-bundle').value, $('account-separator').value);
  if (!bundle) {
    if (manual) throw new Error('未识别到有效的邮箱和密码格式。');
    return;
  }
  setTwoFactorUrl(bundle.twoFactorUrl);
  fields.openaiEmail.value = bundle.email;
  fields.openaiPassword.value = bundle.password;
  await saveConfig();
  renderAccountSummary();
  if (manual) setAccountEditorOpen(false);
}

async function refresh() {
  const state = await chrome.runtime.sendMessage({ type: 'GET_VIEW_STATE' });
  await syncCpaPriorityButton();
  applyConfig(state.config);
  const bundleStorage = await chrome.storage.session.get(ACCOUNT_BUNDLE_SESSION_KEY);
  const savedBundle = String(bundleStorage[ACCOUNT_BUNDLE_SESSION_KEY] || '');
  if (savedBundle && !$('openai-account-bundle').value) $('openai-account-bundle').value = savedBundle;
  const separatorStorage = await chrome.storage.session.get(ACCOUNT_SEPARATOR_SESSION_KEY);
  if (!$('account-separator').value) $('account-separator').value = String(separatorStorage[ACCOUNT_SEPARATOR_SESSION_KEY] || '');
  setTwoFactorUrl(parseOpenAiAccountBundle($('openai-account-bundle').value, $('account-separator').value)?.twoFactorUrl);
  const phaseStorage = await chrome.storage.local.get(AUTH_PHASE_KEY);
  currentPhase = phaseStorage[AUTH_PHASE_KEY] || '';
  renderAccountSummary();
  if (!currentAccountEmail()) setAccountEditorOpen(true);
  if (!state.run && state.status?.type !== 'idle') {
    await chrome.runtime.sendMessage({ type: 'CLEAR_STATUS' });
    renderStatus({ type: 'idle', message: '等待开始授权。' });
    return;
  }
  if (state.status?.phoneNumberRejected) notifyPhoneNumberRejected();
  renderStatus(state.status);
}

// 授权页报告号码被拒时，引导用户在接码区换号。
function notifyPhoneNumberRejected() {
  getPhoneSmsSession().then((session) => {
    if (!session?.activation) return;
    setPhoneSmsStatus('授权页号码被拒，可点击上方“换号重试”获取新号码。', 'error');
  }).catch(() => {});
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (changes[CPA_PENDING_PATCH_KEY]) syncCpaPriorityButton();
  if (changes[AUTH_PHASE_KEY]) {
    currentPhase = changes[AUTH_PHASE_KEY].newValue || '';
    renderAuthSteps();
  }
  const status = changes.autoOauthStatus?.newValue;
  if (!status) return;
  if (status.oneTimeCodeRejected) $('one-time-code').value = '';
  if (status.phoneNumberRejected) notifyPhoneNumberRejected();
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

// ---------- CPA 一键设置 100 权重 ----------
const CPA_PENDING_PATCH_KEY = 'autoOauthCpaPendingPatch';

// CPA 授权成功后 background 会写入待设置记录，按钮只在有待设置账号时显示。
async function syncCpaPriorityButton() {
  const stored = await chrome.storage.local.get(CPA_PENDING_PATCH_KEY);
  $('cpa-priority-actions').classList.toggle('hidden', !stored[CPA_PENDING_PATCH_KEY]);
}

$('set-cpa-priority').addEventListener('click', async () => {
  const button = $('set-cpa-priority');
  button.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: 'SET_CPA_PRIORITY_WEIGHT' });
    if (result?.error) throw new Error(result.error);
  } catch (error) {
    renderStatus({ type: 'error', message: error.message || '设置优先级/权重失败，请重试。' });
  } finally {
    button.disabled = false;
    await syncCpaPriorityButton();
  }
});

$('openai-account-bundle').addEventListener('input', () => {
  const value = $('openai-account-bundle').value;
  if (value) chrome.storage.session.set({ [ACCOUNT_BUNDLE_SESSION_KEY]: value });
  else chrome.storage.session.remove(ACCOUNT_BUNDLE_SESSION_KEY);
  setTwoFactorUrl(parseOpenAiAccountBundle(value, $('account-separator').value)?.twoFactorUrl);
  renderAccountSummary();
});

$('account-separator').addEventListener('input', () => {
  const value = $('account-separator').value;
  if (value) chrome.storage.session.set({ [ACCOUNT_SEPARATOR_SESSION_KEY]: value });
  else chrome.storage.session.remove(ACCOUNT_SEPARATOR_SESSION_KEY);
  setTwoFactorUrl(parseOpenAiAccountBundle($('openai-account-bundle').value, value)?.twoFactorUrl);
  renderAccountSummary();
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

// ---------- 手机接码（HeroSMS） ----------
const PHONE_SMS_CONFIG_KEY = 'autoOauthPhoneSmsConfig';
const PHONE_SMS_SESSION_KEY = 'autoOauthPhoneSmsSession';
const PHONE_SMS_STALE_ORDERS_KEY = 'autoOauthPhoneSmsStaleOrders';

const phoneSms = {
  apiKey: $('hero-sms-api-key'), country: $('hero-sms-country'), balance: $('hero-sms-balance'), acquire: $('hero-sms-acquire'),
  number: $('hero-sms-number'), numberValue: $('hero-sms-number-value'), numberMeta: $('hero-sms-number-meta'),
  copyNumber: $('hero-sms-copy-number'), code: $('hero-sms-code'), codeValue: $('hero-sms-code-value'),
  copyCode: $('hero-sms-copy-code'), status: $('hero-sms-status'), orderActions: $('hero-sms-order-actions'),
  retry: $('hero-sms-retry'), finish: $('hero-sms-finish'), cancel: $('hero-sms-cancel'),
  stale: $('hero-sms-stale-orders'), staleText: $('hero-sms-stale-text'), staleRetry: $('hero-sms-stale-retry'),
};

async function getPhoneSmsConfig() {
  const stored = await chrome.storage.local.get(PHONE_SMS_CONFIG_KEY);
  return { apiKey: '', ...(stored[PHONE_SMS_CONFIG_KEY] || {}) };
}

async function savePhoneSmsConfig(config) {
  await chrome.storage.local.set({ [PHONE_SMS_CONFIG_KEY]: config });
}

async function getPhoneSmsSession() {
  const stored = await chrome.storage.local.get(PHONE_SMS_SESSION_KEY);
  return stored[PHONE_SMS_SESSION_KEY] || null;
}

async function savePhoneSmsSession(session) {
  await chrome.storage.local.set({ [PHONE_SMS_SESSION_KEY]: session });
}

async function getPhoneSmsStaleOrders() {
  const stored = await chrome.storage.local.get(PHONE_SMS_STALE_ORDERS_KEY);
  return Array.isArray(stored[PHONE_SMS_STALE_ORDERS_KEY]) ? stored[PHONE_SMS_STALE_ORDERS_KEY] : [];
}

async function savePhoneSmsStaleOrders(orders) {
  await chrome.storage.local.set({ [PHONE_SMS_STALE_ORDERS_KEY]: orders });
}

function renderPhoneSmsStaleOrders(orders) {
  if (!orders.length) {
    phoneSms.stale.classList.add('hidden');
    return;
  }
  phoneSms.staleText.textContent = `${orders.length} 个旧订单待取消（下单 2 分钟内平台拒绝取消），可稍后点“重试取消”退款`;
  phoneSms.stale.classList.remove('hidden');
}

function setPhoneSmsStatus(message = '', kind = '') {
  phoneSms.status.textContent = message;
  phoneSms.status.className = `phone-sms-status${kind ? ` phone-sms-${kind}` : ''}`;
}

async function copyPhoneSmsText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
  }
}

function renderPhoneSmsSession(session) {
  const activation = session?.activation;
  if (!activation) {
    phoneSms.number.classList.add('hidden');
    phoneSms.code.classList.add('hidden');
    phoneSms.orderActions.classList.add('hidden');
    return;
  }
  phoneSms.numberValue.textContent = activation.phoneNumber;
  const purchasedAt = session.poll?.startedAt ? new Date(session.poll.startedAt) : null;
  const purchasedText = purchasedAt ? ` · 下单 ${purchasedAt.toTimeString().slice(0, 8)}` : '';
  phoneSms.numberMeta.textContent = `${activation.countryLabel || ''} · ${activation.serviceLabel || 'OpenAI'} · 参考价 ${activation.price ?? '-'}${purchasedText}`;
  phoneSms.number.classList.remove('hidden');
  phoneSms.orderActions.classList.remove('hidden');
  if (session.poll?.code) {
    phoneSms.codeValue.textContent = session.poll.code;
    phoneSms.code.classList.remove('hidden');
  } else {
    phoneSms.code.classList.add('hidden');
  }
}

function renderPhoneSmsPollStatus(session) {
  const poll = session?.poll || {};
  const elapsed = poll.startedAt ? Math.max(0, Math.round((Date.now() - poll.startedAt) / 1000)) : 0;
  setPhoneSmsStatus(`轮询中… ${elapsed} 秒 / ${poll.pollCount || 0} 次 / 最新状态：${poll.lastStatus || '等待首次查询'}`);
}

let phoneSmsPollTimer = null;
let phoneSmsPollBusy = false;

function stopPhoneSmsPolling() {
  if (phoneSmsPollTimer) {
    clearInterval(phoneSmsPollTimer);
    phoneSmsPollTimer = null;
  }
  phoneSmsPollBusy = false;
}

function startPhoneSmsPolling(session, apiKey) {
  stopPhoneSmsPolling();
  session.poll = { ...session.poll, status: 'polling', startedAt: session.poll.startedAt || Date.now() };
  phoneSmsPollTimer = setInterval(async () => {
    if (phoneSmsPollBusy) return;
    phoneSmsPollBusy = true;
    try {
      const result = await HeroSmsClient.fetchActivationStatus(apiKey, session.activation.activationId);
      session.poll.pollCount += 1;
      session.poll.lastStatus = result.text;
      if (result.code) {
        session.poll.status = 'received';
        session.poll.code = result.code;
        stopPhoneSmsPolling();
        await savePhoneSmsSession(session);
        renderPhoneSmsSession(session);
        setPhoneSmsStatus(`已收到验证码：${result.code}。请复制使用，完成后点击“完成订单”。`);
        return;
      }
      await savePhoneSmsSession(session);
      renderPhoneSmsPollStatus(session);
      if (Date.now() - session.poll.startedAt >= HeroSmsClient.POLL_TIMEOUT_MS) {
        stopPhoneSmsPolling();
        session.poll.status = 'timeout';
        await savePhoneSmsSession(session);
        renderPhoneSmsSession(session);
        setPhoneSmsStatus('轮询超时（3 分钟）未收到验证码。可点击“取消退款”换号重试。', 'error');
      }
    } catch (error) {
      stopPhoneSmsPolling();
      session.poll.status = 'error';
      session.poll.error = error.message;
      await savePhoneSmsSession(session);
      renderPhoneSmsSession(session);
      setPhoneSmsStatus(error.message || '轮询出错。', 'error');
    } finally {
      phoneSmsPollBusy = false;
    }
  }, HeroSmsClient.POLL_INTERVAL_MS);
}

// 下单新号码并覆盖会话，返回新 session；不处理旧订单，由调用方先取消。
async function placeNewPhoneSmsNumber(apiKey, countryId) {
  const country = HeroSmsClient.COUNTRY_CANDIDATES.find((item) => item.id === Number(countryId));
  if (!country) throw new Error('请选择有效的国家。');
  setPhoneSmsStatus(`正在查询 ${country.label} 价格…`);
  const activation = await HeroSmsClient.acquireNumberForCountry(apiKey, country);
  const session = {
    activation,
    poll: { status: 'polling', startedAt: Date.now(), pollCount: 0, lastStatus: '', code: '' },
  };
  await savePhoneSmsSession(session);
  renderPhoneSmsSession(session);
  setPhoneSmsStatus('号码已获取，开始轮询验证码…');
  startPhoneSmsPolling(session, apiKey);
  return session;
}

async function acquirePhoneSmsNumber() {
  const config = await getPhoneSmsConfig();
  const apiKey = String(config.apiKey || '').trim();
  if (!apiKey) throw new Error('请先填写 HeroSMS API Key。');
  const countryId = Number(phoneSms.country.value);
  phoneSms.acquire.disabled = true;
  try {
    await placeNewPhoneSmsNumber(apiKey, countryId);
  } catch (error) {
    setPhoneSmsStatus(error.message || '获取号码失败。', 'error');
  } finally {
    phoneSms.acquire.disabled = false;
  }
}

// 取消当前订单，返回 { ok, error }。下单 2 分钟内平台会拒绝（EARLY_CANCEL_DENIED）。
async function cancelPhoneSmsOrder(session, apiKey) {
  try {
    await HeroSmsClient.setActivationStatus(apiKey, session.activation.activationId, HeroSmsClient.STATUS_CANCEL);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

// 换号重试：先取消旧订单（被拒则记入待取消列表），再下单新号码。
async function replacePhoneSmsNumber() {
  const config = await getPhoneSmsConfig();
  const apiKey = String(config.apiKey || '').trim();
  if (!apiKey) throw new Error('请先填写 HeroSMS API Key。');
  const session = await getPhoneSmsSession();
  if (!session?.activation) throw new Error('当前没有已获取的号码，请直接点击“获取号码”。');
  phoneSms.retry.disabled = true;
  phoneSms.acquire.disabled = true;
  try {
    stopPhoneSmsPolling();
    const cancel = await cancelPhoneSmsOrder(session, apiKey);
    if (!cancel.ok) {
      const stale = await getPhoneSmsStaleOrders();
      stale.push({
        activationId: session.activation.activationId,
        phoneNumber: session.activation.phoneNumber,
        countryLabel: session.activation.countryLabel || '',
        error: cancel.error,
        attemptedAt: Date.now(),
      });
      await savePhoneSmsStaleOrders(stale);
      renderPhoneSmsStaleOrders(stale);
    }
    setPhoneSmsStatus(
      cancel.ok ? '旧订单已取消退款，正在同国家获取新号码…' : `旧订单暂时无法取消（${cancel.error}），已保留待稍后重试；正在同国家获取新号码…`,
      cancel.ok ? '' : 'error',
    );
    await placeNewPhoneSmsNumber(apiKey, session.activation.countryId);
    setPhoneSmsStatus(
      cancel.ok ? '新号码已获取，旧订单已退款。' : `新号码已获取。旧订单未取消：${cancel.error}，可稍后在下方“重试取消”。`,
      cancel.ok ? '' : 'error',
    );
    // 页面自动化在报错后暂停，换号完成后重新调度，粘贴新号码后会自动继续。
    chrome.runtime.sendMessage({ type: 'RESTART_PAGE_AUTOMATION' }).catch(() => {});
  } catch (error) {
    setPhoneSmsStatus(error.message || '换号失败。', 'error');
  } finally {
    phoneSms.retry.disabled = false;
    phoneSms.acquire.disabled = false;
  }
}

// 重试取消待取消的旧订单（2 分钟锁定期过后即可成功）。
async function retryStaleCancellations() {
  const config = await getPhoneSmsConfig();
  const apiKey = String(config.apiKey || '').trim();
  if (!apiKey) throw new Error('请先填写 HeroSMS API Key。');
  const orders = await getPhoneSmsStaleOrders();
  if (!orders.length) return;
  phoneSms.staleRetry.disabled = true;
  try {
    const remaining = [];
    for (const order of orders) {
      try {
        await HeroSmsClient.setActivationStatus(apiKey, order.activationId, HeroSmsClient.STATUS_CANCEL);
      } catch (error) {
        order.error = error.message;
        order.attemptedAt = Date.now();
        remaining.push(order);
      }
    }
    await savePhoneSmsStaleOrders(remaining);
    renderPhoneSmsStaleOrders(remaining);
    setPhoneSmsStatus(
      remaining.length ? `仍有 ${remaining.length} 个旧订单取消失败：${remaining[0].error}` : '所有旧订单均已取消退款。',
      remaining.length ? 'error' : '',
    );
  } finally {
    phoneSms.staleRetry.disabled = false;
  }
}

async function finishPhoneSmsOrder(statusCode, label) {
  const session = await getPhoneSmsSession();
  if (!session?.activation) return;
  stopPhoneSmsPolling();
  const config = await getPhoneSmsConfig();
  const apiKey = String(config.apiKey || '').trim();
  try {
    if (apiKey) await HeroSmsClient.setActivationStatus(apiKey, session.activation.activationId, statusCode);
  } catch (error) {
    renderPhoneSmsSession(session);
    setPhoneSmsStatus(error.message || '平台状态更新失败。', 'error');
    return;
  }
  await chrome.storage.local.remove(PHONE_SMS_SESSION_KEY);
  renderPhoneSmsSession(null);
  setPhoneSmsStatus(`${label}完成。`);
}

async function queryPhoneSmsBalance() {
  const config = await getPhoneSmsConfig();
  const apiKey = String(config.apiKey || '').trim();
  if (!apiKey) throw new Error('请先填写 HeroSMS API Key。');
  phoneSms.balance.disabled = true;
  try {
    const balance = await HeroSmsClient.fetchBalance(apiKey);
    setPhoneSmsStatus(`余额：${balance}`);
  } catch (error) {
    setPhoneSmsStatus(error.message, 'error');
  } finally {
    phoneSms.balance.disabled = false;
  }
}

async function initPhoneSms() {
  const [config, session, stale] = await Promise.all([getPhoneSmsConfig(), getPhoneSmsSession(), getPhoneSmsStaleOrders()]);
  phoneSms.apiKey.value = config.apiKey || '';
  if (config.countryId) phoneSms.country.value = String(config.countryId);
  renderPhoneSmsStaleOrders(stale);
  if (!session?.activation) return;
  renderPhoneSmsSession(session);
  const apiKey = String(config.apiKey || '').trim();
  if (session.poll?.status === 'polling') {
    if (apiKey) {
      renderPhoneSmsPollStatus(session);
      startPhoneSmsPolling(session, apiKey);
    } else {
      setPhoneSmsStatus('轮询已暂停：缺少 HeroSMS API Key。', 'error');
    }
  } else if (session.poll?.status === 'received') {
    setPhoneSmsStatus(`已收到验证码：${session.poll.code}。请复制使用，完成后点击“完成订单”。`);
  } else if (session.poll?.status === 'timeout') {
    setPhoneSmsStatus('轮询超时（3 分钟）未收到验证码。可点击“取消退款”换号重试。', 'error');
  } else if (session.poll?.status === 'error') {
    setPhoneSmsStatus(session.poll.error || '轮询出错。', 'error');
  }
}

phoneSms.apiKey.addEventListener('change', () => {
  getPhoneSmsConfig().then((config) => savePhoneSmsConfig({ ...config, apiKey: phoneSms.apiKey.value.trim() })).catch(() => {});
});

phoneSms.country.addEventListener('change', () => {
  getPhoneSmsConfig().then((config) => savePhoneSmsConfig({ ...config, countryId: Number(phoneSms.country.value) })).catch(() => {});
});

phoneSms.balance.addEventListener('click', () => {
  queryPhoneSmsBalance().catch((error) => setPhoneSmsStatus(error.message || '查询余额失败。', 'error'));
});

phoneSms.acquire.addEventListener('click', () => {
  // 已有订单时点“获取号码”等价于换号：先取消旧订单再下单，避免旧订单遗留扣费。
  const task = getPhoneSmsSession().then((session) => (
    session?.activation ? replacePhoneSmsNumber() : acquirePhoneSmsNumber()
  ));
  task.catch((error) => setPhoneSmsStatus(error.message || '获取号码失败。', 'error'));
});

phoneSms.copyNumber.addEventListener('click', () => {
  getPhoneSmsSession().then((session) => {
    if (!session?.activation?.phoneNumber) return;
    copyPhoneSmsText(session.activation.phoneNumber).then(() => setPhoneSmsStatus('号码已复制。'));
  }).catch(() => {});
});

phoneSms.copyCode.addEventListener('click', () => {
  getPhoneSmsSession().then((session) => {
    if (!session?.poll?.code) return;
    copyPhoneSmsText(session.poll.code).then(() => setPhoneSmsStatus('验证码已复制。'));
  }).catch(() => {});
});

phoneSms.finish.addEventListener('click', () => {
  finishPhoneSmsOrder(HeroSmsClient.STATUS_FINISH, '订单').catch((error) => setPhoneSmsStatus(error.message, 'error'));
});

phoneSms.cancel.addEventListener('click', () => {
  finishPhoneSmsOrder(HeroSmsClient.STATUS_CANCEL, '退款').catch((error) => setPhoneSmsStatus(error.message, 'error'));
});

phoneSms.retry.addEventListener('click', () => {
  replacePhoneSmsNumber().catch((error) => setPhoneSmsStatus(error.message || '换号失败。', 'error'));
});

phoneSms.staleRetry.addEventListener('click', () => {
  retryStaleCancellations().catch((error) => setPhoneSmsStatus(error.message || '取消旧订单失败。', 'error'));
});

// ---------- 手机接码（DogeSMS） ----------
const DOGE_SMS_CONFIG_KEY = 'autoOauthDogeSmsConfig';
const DOGE_SMS_SESSION_KEY = 'autoOauthDogeSmsSession';
const DOGE_SMS_STALE_ORDERS_KEY = 'autoOauthDogeSmsStaleOrders';

const dogeSms = {
  apiKey: $('doge-sms-api-key'), country: $('doge-sms-country'), balance: $('doge-sms-balance'), acquire: $('doge-sms-acquire'),
  number: $('doge-sms-number'), numberValue: $('doge-sms-number-value'), numberMeta: $('doge-sms-number-meta'),
  copyNumber: $('doge-sms-copy-number'), code: $('doge-sms-code'), codeValue: $('doge-sms-code-value'),
  copyCode: $('doge-sms-copy-code'), status: $('doge-sms-status'), orderActions: $('doge-sms-order-actions'),
  retry: $('doge-sms-retry'), finish: $('doge-sms-finish'), cancel: $('doge-sms-cancel'),
  stale: $('doge-sms-stale-orders'), staleText: $('doge-sms-stale-text'), staleRetry: $('doge-sms-stale-retry'),
};

const phoneSmsProviderButtons = {
  hero: $('phone-sms-provider-hero'),
  doge: $('phone-sms-provider-doge'),
};
const phoneSmsProviderPanels = [...document.querySelectorAll('[data-phone-sms-provider]')];

function selectPhoneSmsProvider(provider) {
  const selected = provider === 'doge' ? 'doge' : 'hero';
  phoneSmsProviderPanels.forEach((panel) => {
    panel.classList.toggle('hidden', panel.dataset.phoneSmsProvider !== selected);
  });
  Object.entries(phoneSmsProviderButtons).forEach(([name, button]) => {
    const active = name === selected;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', String(active));
  });
}

phoneSmsProviderButtons.hero.addEventListener('click', () => selectPhoneSmsProvider('hero'));
phoneSmsProviderButtons.doge.addEventListener('click', () => selectPhoneSmsProvider('doge'));
selectPhoneSmsProvider('hero');

async function getDogeSmsConfig() {
  const stored = await chrome.storage.local.get(DOGE_SMS_CONFIG_KEY);
  return { apiKey: '', ...(stored[DOGE_SMS_CONFIG_KEY] || {}) };
}

async function saveDogeSmsConfig(config) {
  await chrome.storage.local.set({ [DOGE_SMS_CONFIG_KEY]: config });
}

async function getDogeSmsSession() {
  const stored = await chrome.storage.local.get(DOGE_SMS_SESSION_KEY);
  return stored[DOGE_SMS_SESSION_KEY] || null;
}

async function saveDogeSmsSession(session) {
  await chrome.storage.local.set({ [DOGE_SMS_SESSION_KEY]: session });
}

async function getDogeSmsStaleOrders() {
  const stored = await chrome.storage.local.get(DOGE_SMS_STALE_ORDERS_KEY);
  return Array.isArray(stored[DOGE_SMS_STALE_ORDERS_KEY]) ? stored[DOGE_SMS_STALE_ORDERS_KEY] : [];
}

async function saveDogeSmsStaleOrders(orders) {
  await chrome.storage.local.set({ [DOGE_SMS_STALE_ORDERS_KEY]: orders });
}

function renderDogeSmsStaleOrders(orders) {
  if (!orders.length) {
    dogeSms.stale.classList.add('hidden');
    return;
  }
  dogeSms.staleText.textContent = `${orders.length} 个旧订单待取消（平台暂时拒绝取消），可稍后点“重试取消”退款`;
  dogeSms.stale.classList.remove('hidden');
}

function setDogeSmsStatus(message = '', kind = '') {
  dogeSms.status.textContent = message;
  dogeSms.status.className = `phone-sms-status${kind ? ` phone-sms-${kind}` : ''}`;
}

function formatDogeSmsPrice(cents) {
  if (!Number.isFinite(Number(cents))) return '-';
  return `$${(Number(cents) / 100).toFixed(2)}`;
}

function renderDogeSmsSession(session) {
  const activation = session?.activation;
  if (!activation) {
    dogeSms.number.classList.add('hidden');
    dogeSms.code.classList.add('hidden');
    dogeSms.orderActions.classList.add('hidden');
    return;
  }
  const hasNumber = Boolean(activation.phoneNumber);
  dogeSms.numberValue.textContent = activation.phoneNumber || '等待平台分配…';
  const purchasedAt = session.poll?.startedAt ? new Date(session.poll.startedAt) : null;
  const purchasedText = purchasedAt ? ` · 下单 ${purchasedAt.toTimeString().slice(0, 8)}` : '';
  dogeSms.numberMeta.textContent = `${activation.countryLabel || ''} · ${activation.serviceLabel || 'OpenAI'} · 参考价 ${formatDogeSmsPrice(activation.priceCents)}${purchasedText}`;
  dogeSms.number.classList.remove('hidden');
  dogeSms.orderActions.classList.toggle('hidden', !hasNumber);
  if (session.poll?.code) {
    dogeSms.codeValue.textContent = session.poll.code;
    dogeSms.code.classList.remove('hidden');
  } else {
    dogeSms.code.classList.add('hidden');
  }
}

function renderDogeSmsPollStatus(session) {
  const poll = session?.poll || {};
  const elapsed = poll.startedAt ? Math.max(0, Math.round((Date.now() - poll.startedAt) / 1000)) : 0;
  const phase = session?.activation?.phoneNumber ? '等待验证码' : '等待号码分配';
  setDogeSmsStatus(`${phase}… ${elapsed} 秒 / ${poll.pollCount || 0} 次 / 最新状态：${poll.lastStatus || '等待首次查询'}`);
}

let dogeSmsPollTimer = null;
let dogeSmsPollBusy = false;

function stopDogeSmsPolling() {
  if (dogeSmsPollTimer) {
    clearInterval(dogeSmsPollTimer);
    dogeSmsPollTimer = null;
  }
  dogeSmsPollBusy = false;
}

function extractDogeSmsCode(order) {
  const code = String(order?.smsCode || '').trim();
  if (code) return code;
  const content = String(order?.smsContent || '').trim();
  const match = content.match(/\b(\d{4,8})\b/);
  return match ? match[1] : '';
}

function startDogeSmsPolling(session, apiKey) {
  stopDogeSmsPolling();
  session.poll = { ...session.poll, status: 'polling', startedAt: session.poll.startedAt || Date.now() };
  dogeSmsPollTimer = setInterval(async () => {
    if (dogeSmsPollBusy) return;
    dogeSmsPollBusy = true;
    try {
      const order = await DogeSmsClient.fetchOrder(apiKey, session.activation.orderId);
      session.poll.pollCount += 1;
      session.poll.lastStatus = order?.status || 'unknown';

      if (order?.status === 'active' && order.phoneNumber && !session.activation.phoneNumber) {
        session.activation.phoneNumber = order.phoneNumber;
        session.activation.amountCents = order.amountCents;
        await saveDogeSmsSession(session);
        renderDogeSmsSession(session);
        setDogeSmsStatus(`号码已分配：${order.phoneNumber}，继续等待验证码…`);
      }

      if (order?.status === 'completed') {
        const code = extractDogeSmsCode(order);
        session.poll.status = 'received';
        session.poll.code = code;
        if (order.phoneNumber) session.activation.phoneNumber = order.phoneNumber;
        stopDogeSmsPolling();
        await saveDogeSmsSession(session);
        renderDogeSmsSession(session);
        setDogeSmsStatus(code ? `已收到验证码：${code}。请复制使用，完成后点击“完成订单”。` : '短信已到达，但未能提取验证码，请查看详情。');
        return;
      }

      if (['expired', 'failed', 'cancelled'].includes(order?.status)) {
        stopDogeSmsPolling();
        session.poll.status = 'error';
        session.poll.error = order.errorMessage || `订单已${order.status === 'expired' ? '过期' : order.status === 'failed' ? '失败' : '取消'}`;
        await saveDogeSmsSession(session);
        renderDogeSmsSession(session);
        setDogeSmsStatus(session.poll.error, 'error');
        return;
      }

      await saveDogeSmsSession(session);
      renderDogeSmsPollStatus(session);
      if (Date.now() - session.poll.startedAt >= DogeSmsClient.POLL_TIMEOUT_MS) {
        stopDogeSmsPolling();
        session.poll.status = 'timeout';
        await saveDogeSmsSession(session);
        renderDogeSmsSession(session);
        setDogeSmsStatus('轮询超时（3 分钟）未收到验证码。可点击“取消退款”换号重试。', 'error');
      }
    } catch (error) {
      stopDogeSmsPolling();
      session.poll.status = 'error';
      session.poll.error = error.message;
      await saveDogeSmsSession(session);
      renderDogeSmsSession(session);
      setDogeSmsStatus(error.message || '轮询出错。', 'error');
    } finally {
      dogeSmsPollBusy = false;
    }
  }, DogeSmsClient.POLL_INTERVAL_MS);
}

// 下单新号码并覆盖会话，返回新 session；不处理旧订单，由调用方先取消。
async function placeNewDogeSmsNumber(apiKey, countryCode) {
  const country = DogeSmsClient.COUNTRY_CANDIDATES.find((item) => item.code === countryCode);
  if (!country) throw new Error('请选择有效的国家。');
  setDogeSmsStatus(`正在查询 ${country.label} 价格…`);
  const priced = await DogeSmsClient.fetchCountryPrice(apiKey, country);
  if (!priced) throw new Error(`${country.label} 当前无可用价格，请切换国家或稍后重试。`);
  setDogeSmsStatus('正在创建订单…');
  const order = await DogeSmsClient.createOrder(apiKey, country, priced.priceCents);
  const session = {
    activation: {
      orderId: order.orderId,
      orderNo: order.orderNo,
      countryCode: country.code,
      countryLabel: country.label,
      serviceCode: DogeSmsClient.SERVICE_CODE,
      serviceLabel: DogeSmsClient.SERVICE_LABEL,
      priceCents: priced.priceCents,
      phoneNumber: order.phoneNumber || '',
      amountCents: order.amountCents,
      currency: order.currency,
    },
    poll: { status: 'polling', startedAt: Date.now(), pollCount: 0, lastStatus: order.status || 'pending', code: '' },
  };
  await saveDogeSmsSession(session);
  renderDogeSmsSession(session);
  setDogeSmsStatus(order.phoneNumber ? '号码已获取，开始轮询验证码…' : '订单已创建，等待平台分配号码…');
  startDogeSmsPolling(session, apiKey);
  return session;
}

async function acquireDogeSmsNumber() {
  const config = await getDogeSmsConfig();
  const apiKey = String(config.apiKey || '').trim();
  if (!apiKey) throw new Error('请先填写 DogeSMS API Key。');
  const countryCode = dogeSms.country.value;
  dogeSms.acquire.disabled = true;
  try {
    await placeNewDogeSmsNumber(apiKey, countryCode);
  } catch (error) {
    setDogeSmsStatus(error.message || '获取号码失败。', 'error');
  } finally {
    dogeSms.acquire.disabled = false;
  }
}

// 取消当前订单，返回 { ok, error }。
async function cancelDogeSmsOrder(session, apiKey) {
  try {
    await DogeSmsClient.cancelOrder(apiKey, session.activation.orderId);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

// 换号重试：先取消旧订单（被拒则记入待取消列表），再同国家下单新号码。
async function replaceDogeSmsNumber() {
  const config = await getDogeSmsConfig();
  const apiKey = String(config.apiKey || '').trim();
  if (!apiKey) throw new Error('请先填写 DogeSMS API Key。');
  const session = await getDogeSmsSession();
  if (!session?.activation) throw new Error('当前没有已获取的号码，请直接点击“获取号码”。');
  dogeSms.retry.disabled = true;
  dogeSms.acquire.disabled = true;
  try {
    stopDogeSmsPolling();
    const cancel = await cancelDogeSmsOrder(session, apiKey);
    if (!cancel.ok) {
      const stale = await getDogeSmsStaleOrders();
      stale.push({
        orderId: session.activation.orderId,
        phoneNumber: session.activation.phoneNumber || '',
        countryLabel: session.activation.countryLabel || '',
        error: cancel.error,
        attemptedAt: Date.now(),
      });
      await saveDogeSmsStaleOrders(stale);
      renderDogeSmsStaleOrders(stale);
    }
    setDogeSmsStatus(
      cancel.ok ? '旧订单已取消，正在同国家获取新号码…' : `旧订单暂时无法取消（${cancel.error}），已保留待稍后重试；正在同国家获取新号码…`,
      cancel.ok ? '' : 'error',
    );
    await placeNewDogeSmsNumber(apiKey, session.activation.countryCode);
    setDogeSmsStatus(
      cancel.ok ? '新号码已获取，旧订单已取消。' : `新订单已创建。旧订单未取消：${cancel.error}，可稍后在下方“重试取消”。`,
      cancel.ok ? '' : 'error',
    );
    chrome.runtime.sendMessage({ type: 'RESTART_PAGE_AUTOMATION' }).catch(() => {});
  } catch (error) {
    setDogeSmsStatus(error.message || '换号失败。', 'error');
  } finally {
    dogeSms.retry.disabled = false;
    dogeSms.acquire.disabled = false;
  }
}

// 重试取消待取消的旧订单。
async function retryDogeStaleCancellations() {
  const config = await getDogeSmsConfig();
  const apiKey = String(config.apiKey || '').trim();
  if (!apiKey) throw new Error('请先填写 DogeSMS API Key。');
  const orders = await getDogeSmsStaleOrders();
  if (!orders.length) return;
  dogeSms.staleRetry.disabled = true;
  try {
    const remaining = [];
    for (const order of orders) {
      try {
        await DogeSmsClient.cancelOrder(apiKey, order.orderId);
      } catch (error) {
        order.error = error.message;
        order.attemptedAt = Date.now();
        remaining.push(order);
      }
    }
    await saveDogeSmsStaleOrders(remaining);
    renderDogeSmsStaleOrders(remaining);
    setDogeSmsStatus(
      remaining.length ? `仍有 ${remaining.length} 个旧订单取消失败：${remaining[0].error}` : '所有旧订单均已取消退款。',
      remaining.length ? 'error' : '',
    );
  } finally {
    dogeSms.staleRetry.disabled = false;
  }
}

async function finishDogeSmsOrder(label) {
  const session = await getDogeSmsSession();
  if (!session?.activation) return;
  stopDogeSmsPolling();
  await chrome.storage.local.remove(DOGE_SMS_SESSION_KEY);
  renderDogeSmsSession(null);
  setDogeSmsStatus(`${label}完成。`);
}

async function cancelDogeSmsRefund() {
  const session = await getDogeSmsSession();
  if (!session?.activation) return;
  stopDogeSmsPolling();
  const config = await getDogeSmsConfig();
  const apiKey = String(config.apiKey || '').trim();
  try {
    if (apiKey) {
      const order = await DogeSmsClient.cancelOrder(apiKey, session.activation.orderId);
      if (order?.status === 'completed') {
        setDogeSmsStatus('订单已完成（验证码已送达），无法退款。', 'error');
        return;
      }
    }
  } catch (error) {
    if (/CANCEL_TOO_EARLY/i.test(error.message)) {
      const stale = await getDogeSmsStaleOrders();
      stale.push({
        orderId: session.activation.orderId,
        phoneNumber: session.activation.phoneNumber || '',
        countryLabel: session.activation.countryLabel || '',
        error: error.message,
        attemptedAt: Date.now(),
      });
      await saveDogeSmsStaleOrders(stale);
      renderDogeSmsStaleOrders(stale);
      setDogeSmsStatus(`${error.message}，已加入“重试取消”列表。`, 'error');
      return;
    }
    renderDogeSmsSession(session);
    setDogeSmsStatus(error.message || '取消退款失败。', 'error');
    return;
  }
  await chrome.storage.local.remove(DOGE_SMS_SESSION_KEY);
  renderDogeSmsSession(null);
  setDogeSmsStatus('退款完成。');
}

async function queryDogeSmsBalance() {
  const config = await getDogeSmsConfig();
  const apiKey = String(config.apiKey || '').trim();
  if (!apiKey) throw new Error('请先填写 DogeSMS API Key。');
  dogeSms.balance.disabled = true;
  try {
    const { balanceCents, currency } = await DogeSmsClient.fetchBalance(apiKey);
    setDogeSmsStatus(`余额：${formatDogeSmsPrice(balanceCents)} ${currency}`);
  } catch (error) {
    setDogeSmsStatus(error.message, 'error');
  } finally {
    dogeSms.balance.disabled = false;
  }
}

async function initDogeSms() {
  const [config, session, stale] = await Promise.all([getDogeSmsConfig(), getDogeSmsSession(), getDogeSmsStaleOrders()]);
  dogeSms.apiKey.value = config.apiKey || '';
  if (config.countryCode) dogeSms.country.value = String(config.countryCode);
  renderDogeSmsStaleOrders(stale);
  if (!session?.activation) return;
  renderDogeSmsSession(session);
  const apiKey = String(config.apiKey || '').trim();
  if (session.poll?.status === 'polling') {
    if (apiKey) {
      renderDogeSmsPollStatus(session);
      startDogeSmsPolling(session, apiKey);
    } else {
      setDogeSmsStatus('轮询已暂停：缺少 DogeSMS API Key。', 'error');
    }
  } else if (session.poll?.status === 'received') {
    setDogeSmsStatus(`已收到验证码：${session.poll.code}。请复制使用，完成后点击“完成订单”。`);
  } else if (session.poll?.status === 'timeout') {
    setDogeSmsStatus('轮询超时（3 分钟）未收到验证码。可点击“取消退款”换号重试。', 'error');
  } else if (session.poll?.status === 'error') {
    setDogeSmsStatus(session.poll.error || '轮询出错。', 'error');
  }
}

dogeSms.apiKey.addEventListener('change', () => {
  getDogeSmsConfig().then((config) => saveDogeSmsConfig({ ...config, apiKey: dogeSms.apiKey.value.trim() })).catch(() => {});
});

dogeSms.country.addEventListener('change', () => {
  getDogeSmsConfig().then((config) => saveDogeSmsConfig({ ...config, countryCode: dogeSms.country.value })).catch(() => {});
});

dogeSms.balance.addEventListener('click', () => {
  queryDogeSmsBalance().catch((error) => setDogeSmsStatus(error.message || '查询余额失败。', 'error'));
});

dogeSms.acquire.addEventListener('click', () => {
  const task = getDogeSmsSession().then((session) => (
    session?.activation ? replaceDogeSmsNumber() : acquireDogeSmsNumber()
  ));
  task.catch((error) => setDogeSmsStatus(error.message || '获取号码失败。', 'error'));
});

dogeSms.copyNumber.addEventListener('click', () => {
  getDogeSmsSession().then((session) => {
    if (!session?.activation?.phoneNumber) return;
    copyPhoneSmsText(session.activation.phoneNumber).then(() => setDogeSmsStatus('号码已复制。'));
  }).catch(() => {});
});

dogeSms.copyCode.addEventListener('click', () => {
  getDogeSmsSession().then((session) => {
    if (!session?.poll?.code) return;
    copyPhoneSmsText(session.poll.code).then(() => setDogeSmsStatus('验证码已复制。'));
  }).catch(() => {});
});

dogeSms.finish.addEventListener('click', () => {
  finishDogeSmsOrder('订单').catch((error) => setDogeSmsStatus(error.message, 'error'));
});

dogeSms.cancel.addEventListener('click', () => {
  cancelDogeSmsRefund().catch((error) => setDogeSmsStatus(error.message, 'error'));
});

dogeSms.retry.addEventListener('click', () => {
  replaceDogeSmsNumber().catch((error) => setDogeSmsStatus(error.message || '换号失败。', 'error'));
});

dogeSms.staleRetry.addEventListener('click', () => {
  retryDogeStaleCancellations().catch((error) => setDogeSmsStatus(error.message || '取消旧订单失败。', 'error'));
});

refresh().catch((error) => renderStatus({ type: 'error', message: error.message || '无法读取配置。' }));
initPhoneSms().catch(() => {});
initDogeSms().catch(() => {});
