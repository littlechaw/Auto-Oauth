(() => {
  const RUN_MARK = 'data-auto-oauth-running';
  const visible = (element) => {
    if (!element) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  };

  const setValue = (element, value) => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    descriptor?.set?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  };

  const submitNearestForm = (element) => {
    const form = element.closest('form');
    const submitter = form?.querySelector('button[type="submit"], input[type="submit"]');
    if (submitter && visible(submitter) && !submitter.disabled) {
      submitter.click();
      return true;
    }
    if (form?.requestSubmit) {
      form.requestSubmit();
      return true;
    }
    return false;
  };

  const findEmailInput = () => [...document.querySelectorAll('input')].find((input) => (
    visible(input) && !input.disabled && (input.type === 'email' || /email|邮箱|メール/i.test(`${input.name} ${input.autocomplete} ${input.placeholder} ${input.ariaLabel}`))
  ));

  const findPasswordInput = () => [...document.querySelectorAll('input[type="password"]')].find((input) => visible(input) && !input.disabled);

  const findOneTimeCodeInputs = () => [...document.querySelectorAll('input')].filter((input) => (
    visible(input)
    && !input.disabled
    && (
      input.autocomplete === 'one-time-code'
      || /code|otp|verification|验证码|認証|確認/i.test(`${input.name} ${input.id} ${input.placeholder} ${input.ariaLabel}`)
      || (input.inputMode === 'numeric' && (Number(input.maxLength) === 1 || Number(input.maxLength) >= 4))
    )
  ));

  const fillOneTimeCode = (rawCode) => {
    const code = String(rawCode || '').replace(/\s+/g, '');
    if (!code) return { ok: false, error: '一次性验证码不能为空。' };
    const inputs = findOneTimeCodeInputs();
    if (!inputs.length) return { ok: false, error: '当前页面未找到验证码输入框。' };

    const splitInputs = inputs.filter((input) => Number(input.maxLength) === 1);
    if (splitInputs.length >= code.length) {
      splitInputs.slice(0, code.length).forEach((input, index) => setValue(input, code[index]));
      submitNearestForm(splitInputs[0]);
      return { ok: true };
    }

    const input = inputs.find((candidate) => Number(candidate.maxLength) !== 1) || inputs[0];
    setValue(input, code);
    submitNearestForm(input);
    return { ok: true };
  };

  let codeFillInFlight = false;
  let oneTimeCodeAttempt = 0;

  const clearOneTimeCodeInputs = () => {
    findOneTimeCodeInputs().forEach((input) => setValue(input, ''));
  };

  const hasRedColor = (value) => [...String(value || '').matchAll(/rgba?\(\s*(\d+)\s*[, ]\s*(\d+)\s*[, ]\s*(\d+)/gi)].some(([, red, green, blue]) => {
    const [r, g, b] = [red, green, blue].map(Number);
    return r >= 140 && r >= g * 1.4 && r >= b * 1.4;
  });

  const hasOneTimeCodeErrorStyle = (input) => {
    const style = getComputedStyle(input);
    return [
      style.color,
      style.backgroundColor,
      style.borderTopColor,
      style.borderRightColor,
      style.borderBottomColor,
      style.borderLeftColor,
      style.outlineColor,
      style.boxShadow,
    ].some(hasRedColor);
  };

  const clearRejectedOneTimeCode = async (code, attempt) => {
    const timeoutAt = Date.now() + 4000;
    let reason = '验证码未通过或页面未继续，请修改后重新填写。';
    while (attempt === oneTimeCodeAttempt) {
      const inputs = findOneTimeCodeInputs();
      if (!inputs.length) return;
      if (inputs.some(hasOneTimeCodeErrorStyle)) {
        reason = '验证码输入框显示错误，请修改后重新填写。';
        break;
      }
      if (Date.now() >= timeoutAt) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (attempt !== oneTimeCodeAttempt) return;
    const response = await chrome.runtime.sendMessage({ type: 'REJECT_ONE_TIME_CODE', payload: { code, reason } });
    if (!response?.cleared) return;
    clearOneTimeCodeInputs();
    oneTimeCodeAttempt += 1;
  };

  const fillPendingOneTimeCode = async () => {
    if (codeFillInFlight || !findOneTimeCodeInputs().length) return false;
    codeFillInFlight = true;
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_PENDING_ONE_TIME_CODE' });
      if (!response?.code) return false;
      const result = fillOneTimeCode(response.code);
      if (!result.ok) return false;
      await chrome.runtime.sendMessage({ type: 'CONSUME_ONE_TIME_CODE', payload: { code: response.code } });
      const attempt = ++oneTimeCodeAttempt;
      clearRejectedOneTimeCode(response.code, attempt).catch(() => {});
      return true;
    } finally {
      codeFillInFlight = false;
    }
  };

  const getAddPhoneForm = () => document.querySelector('form[action*="/add-phone" i]');

  const getAddPhoneInput = (form) => form.querySelector('input[type="tel"], input[name="__reservedForPhoneNumberInput_tel"], input[autocomplete="tel"]');

  const getAddPhoneSmsRadio = (form) => form.querySelector('input[type="radio"][value="sms"]');

  const getAddPhoneSelectedChannel = (form) => {
    const hidden = form.querySelector('input[type="hidden"][name="channel"]');
    if (hidden) return String(hidden.value || '').trim().toLowerCase();
    const radio = document.querySelector('input[type="radio"][name^="segmented-control"]:checked');
    return String(radio?.value || '').trim().toLowerCase();
  };

  // 手机号表单提交前必须选中短信渠道：接码平台收不到 WhatsApp 消息。
  const ensureSmsChannelSelected = (form) => {
    const smsRadio = getAddPhoneSmsRadio(form);
    if (!smsRadio) return true;
    if (getAddPhoneSelectedChannel(form) === 'sms') return true;
    const label = smsRadio.closest('label');
    if (!label) return false;
    label.click();
    return getAddPhoneSelectedChannel(form) === 'sms';
  };

  const getAddPhoneErrorText = (form) => {
    const messages = [];
    const selectors = [
      '.react-aria-FieldError',
      '[slot="errorMessage"]',
      '[id$="-error"]',
      '[data-invalid="true"] + *',
      '[aria-invalid="true"] + *',
      '[class*="error"]',
    ];
    for (const selector of selectors) {
      form.querySelectorAll(selector).forEach((element) => {
        const text = String(element?.textContent || '').replace(/\s+/g, ' ').trim();
        if (text) messages.push(text);
      });
    }
    const invalidInput = form.querySelector('input[aria-invalid="true"], input[data-invalid="true"]');
    if (invalidInput) {
      const wrapper = invalidInput.closest('form, [data-rac], div');
      const text = String(wrapper?.textContent || '').replace(/\s+/g, ' ').trim();
      if (text) messages.push(text);
    }
    const preferred = messages.find((text) => (
      /already|used|linked|eligible|invalid|phone|号码|手机号|错误|失败|try\s+again/i.test(text)
    ));
    return preferred || (invalidInput ? (messages[0] || '') : '');
  };

  const clickUseAnotherAccount = () => {
    const pattern = /^(?:use\s+(?:another|a\s+different)\s+account|sign\s*in\s+with\s+(?:another|a\s+different)\s+account|other\s+account|登录至(?:另一个|其他|另一|别的)账户|登陆至(?:另一个|其他|另一|别的)账户|登录(?:其他|另一|别的)账号|登陆(?:其他|另一|别的)账号|使用(?:其他|另一|别的)账号|其他账号|另一账号|别的账号|別(?:の)?アカウント)$/i;
    const candidates = [...document.querySelectorAll('button, a, [role="button"], [role="link"]')];
    const entry = candidates.find((candidate) => (
      visible(candidate) && !candidate.disabled && pattern.test((candidate.textContent || '').trim())
    ));
    if (!entry) return false;
    entry.click();
    return true;
  };

  const clickConsent = () => {
    const form = document.querySelector('form[action*="/sign-in-with-chatgpt/" i][action*="/consent" i]');
    const candidates = form
      ? [...form.querySelectorAll('button[type="submit"], input[type="submit"]')]
      : [...document.querySelectorAll('button[type="submit"], [role="button"]')];
    const consentPattern = /^(continue|authorize|allow|agree|继续|同意|允许|授权|承認|続ける)$/i;
    const button = candidates.find((candidate) => visible(candidate) && !candidate.disabled && consentPattern.test((candidate.textContent || candidate.value || '').trim()));
    if (!button) return false;
    button.click();
    return true;
  };

  function run(payload = {}) {
    if (document.documentElement.getAttribute(RUN_MARK) === '1') return;
    document.documentElement.setAttribute(RUN_MARK, '1');
    const email = String(payload.email || '').trim();
    const password = String(payload.password || '');
    let attempts = 0;
    let phoneErrorReported = false;
    const timer = setInterval(async () => {
      attempts += 1;
      const stopRun = () => {
        clearInterval(timer);
        document.documentElement.removeAttribute(RUN_MARK);
      };
      try {
        if (await fillPendingOneTimeCode()) {
          stopRun();
          return;
        }
        if (findOneTimeCodeInputs().length) {
          stopRun();
          return;
        }
        if (clickUseAnotherAccount()) {
          return;
        }
        // 手机号表单：号码异常时暂停点击并报错一次，等人工换号后自动恢复；
        // 号码已输入时先选中短信渠道再提交，未输入号码时不点击。
        const addPhoneForm = getAddPhoneForm();
        if (addPhoneForm) {
          const phoneError = getAddPhoneErrorText(addPhoneForm);
          if (phoneError) {
            if (!phoneErrorReported) {
              phoneErrorReported = true;
              chrome.runtime.sendMessage({ type: 'REPORT_PHONE_FORM_ERROR', payload: { error: phoneError } }).catch(() => {});
            }
            return;
          }
          phoneErrorReported = false;
          const phoneInput = getAddPhoneInput(addPhoneForm);
          const hasNumber = Boolean(phoneInput && phoneInput.value && phoneInput.value.replace(/\D/g, '').length >= 5);
          if (hasNumber && ensureSmsChannelSelected(addPhoneForm)) {
            const submitter = addPhoneForm.querySelector('button[type="submit"], input[type="submit"]');
            if (submitter && visible(submitter) && !submitter.disabled) submitter.click();
          }
          return;
        }
        const passwordInput = findPasswordInput();
        if (passwordInput && password && passwordInput.value !== password) {
          setValue(passwordInput, password);
          submitNearestForm(passwordInput);
          return;
        }
        const emailInput = findEmailInput();
        if (emailInput && email && emailInput.value !== email) {
          setValue(emailInput, email);
          submitNearestForm(emailInput);
          return;
        }
        clickConsent();
      } finally {
        if (attempts >= 180) {
          clearInterval(timer);
          document.documentElement.removeAttribute(RUN_MARK);
        }
      }
    }, 1000);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'AUTO_OAUTH_FILL_AND_CONFIRM') {
      run(message.payload || {});
      return;
    }
    if (message?.type === 'AUTO_OAUTH_RETRY_ONE_TIME_CODE') {
      fillPendingOneTimeCode().then(sendResponse);
      return true;
    }
    if (message?.type === 'AUTO_OAUTH_FILL_ONE_TIME_CODE') sendResponse(fillOneTimeCode(message.payload?.code));
  });
})();
