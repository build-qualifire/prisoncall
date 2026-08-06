/* Transfer Prison Modal — standalone 6-step flow
   Inject via: <script src="/transfer-prison-modal.js"></script>
   Trigger with: <a href="#" data-transfer-prison> or class="transfer-prison-trigger"
*/
(function () {
  'use strict';

  /* ── Prison data (mirrors choose-plan.html) ──────────────────────────────── */
  var PRISONS = {
    vic: [
      'Barwon Prison', 'Beechworth Correctional Centre', 'Dame Phyllis Frost Centre',
      'Fulham Correctional Centre', 'Hopkins Correctional Centre', 'Langi Kal Kal Prison',
      'Loddon Prison / Middleton Prison', 'Marngoneet Correctional Centre',
      'Melbourne Assessment Prison', 'Metropolitan Remand Centre', 'Port Phillip Prison',
      'Ravenhall Correctional Centre', 'Tarrengower Prison', 'Western Plains Correctional Centre',
    ],
    nsw: [
      'Amber Laurel CC', 'Balund-a', 'Bathurst CC', 'Broken Hill CC',
      'Cessnock CC', 'Clarence CC', 'Cooma CC', 'Dawn de Loas CC',
      'Dillwynia CC', 'Emu Plains CC', 'Geoffrey Pearce CC', 'Glen Innes CC',
      'Goulburn CC', 'Hunter CC', 'John Morony CC', 'Junee CC',
      'Kariong Intake & Transit', 'Kirkconnell CC', 'Lithgow CC', 'Long Bay Complex',
      'Macquarie CC', 'Mannus CC', 'Mary Wade CC', 'Mid North Coast CC (Kempsey)',
      'MRRC Silverwater', 'Oberon CC', 'Parklea CC', 'Shortland CC',
      "Silverwater CC (Men's)", "Silverwater Women's CC", 'South Coast CC',
      'St Heliers CC', 'Tamworth CC', 'Wellington CC',
    ],
  };

  /* ── Modal state ─────────────────────────────────────────────────────────── */
  var state = {
    step: 1,
    selectedState: null,   // 'vic' | 'nsw'
    did: null,             // 10-digit string from step 1
    currentPrison: null,   // from /api/check-did response
    confirmedDid: null,    // re-entry from step 2
    mobile: null,          // clean 10-digit mobile
    selectedPrison: null,  // chosen in step 4
  };

  /* ── DEV TOOLS state (staging only) ──────────────────────────────────────── */
  var devSkipStep3 = false;
  var devPanelEl = null;

  /* ── DOM refs ─────────────────────────────────────────────────────────────── */
  var overlay, card, closeConfirmPanel, stepContent;

  /* ── Helpers ──────────────────────────────────────────────────────────────── */
  function esc(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatMobile(digits) {
    var d = (digits || '').replace(/\D/g, '');
    if (d.length === 10) return d.slice(0, 4) + ' ' + d.slice(4, 7) + ' ' + d.slice(7);
    return d;
  }

  function maskMobile(digits) {
    var d = (digits || '').replace(/\D/g, '');
    if (d.length < 10) return d;
    return d.slice(0, 4) + ' XXX ' + d.slice(7);
  }

  function setLoading(btn, text) {
    btn.disabled = true;
    btn.textContent = text;
  }

  function restoreBtn(btn, text) {
    btn.disabled = false;
    btn.textContent = text;
  }

  function showError(inputEl, errorEl, msg) {
    inputEl.classList.add('tpm-has-error');
    errorEl.textContent = msg;
    errorEl.classList.add('tpm-visible');
  }

  function clearError(inputEl, errorEl) {
    inputEl.classList.remove('tpm-has-error');
    errorEl.classList.remove('tpm-visible');
    errorEl.textContent = '';
  }

  /* ── DEV TOOLS panel (prisoncall.pages.dev only) ────────────────────────── */
  function injectDevPanel() {
    if (window.location.hostname !== 'prisoncall.pages.dev') return;
    if (devPanelEl) return;

    devPanelEl = document.createElement('div');
    devPanelEl.className = 'tpm-dev-panel';
    devPanelEl.setAttribute('role', 'region');
    devPanelEl.setAttribute('aria-label', 'Developer tools');
    devPanelEl.innerHTML = [
      '<p class="tpm-dev-panel__title">Dev Tools</p>',
      '<div class="tpm-dev-panel__row">',
        '<span class="tpm-dev-panel__label">Skip Step 3</span>',
        '<label class="tpm-dev-toggle" aria-label="Toggle Skip Step 3">',
          '<input type="checkbox" id="tpm-dev-toggle-skip3">',
          '<span class="tpm-dev-toggle__track"></span>',
        '</label>',
      '</div>',
    ].join('');
    document.body.appendChild(devPanelEl);

    devPanelEl.querySelector('#tpm-dev-toggle-skip3').addEventListener('change', function () {
      devSkipStep3 = this.checked;
      var btn = document.getElementById('tpm-dev-skip-step3-btn');
      if (btn) btn.style.display = devSkipStep3 ? 'block' : 'none';
    });
  }

  function removeDevPanel() {
    if (devPanelEl && devPanelEl.parentNode) {
      devPanelEl.parentNode.removeChild(devPanelEl);
    }
    devPanelEl = null;
    devSkipStep3 = false;
  }

  /* ── CSS injection ────────────────────────────────────────────────────────── */
  function injectCSS() {
    var style = document.createElement('style');
    style.textContent = [
      '#tpm-overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9999;display:none;',
        'align-items:center;justify-content:center;padding:16px;',
        "font-family:'Plus Jakarta Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}",
      '#tpm-overlay.tpm-open{display:flex;}',

      '#tpm-card{background:#fff;border-radius:16px;padding:32px;width:100%;max-width:560px;',
        'position:relative;box-sizing:border-box;max-height:90vh;display:flex;flex-direction:column;overflow:hidden;}',

      '#tpm-step-content{flex:1;overflow-y:auto;min-height:0;}',

      '.tpm-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px;',
        'position:sticky;top:0;background:#fff;z-index:1;padding-bottom:4px;}',
      '.tpm-back{background:none;border:none;color:#888;font-size:14px;cursor:pointer;',
        "font-family:inherit;padding:0;line-height:1;transition:color 150ms ease;}",
      '.tpm-back:hover{color:#000;}',
      '.tpm-header-right{display:flex;flex-direction:column;align-items:flex-end;gap:6px;}',
      '.tpm-close-btn{background:none;border:none;font-size:24px;cursor:pointer;color:#666;',
        'padding:0;line-height:1;font-family:inherit;transition:color 150ms ease;}',
      '.tpm-close-btn:hover{color:#000;}',
      '.tpm-step-ind{font-size:11px;font-weight:600;color:#999;letter-spacing:.05em;text-transform:uppercase;}',

      '.tpm-close-confirm{position:absolute;inset:0;border-radius:16px;z-index:2;',
        'display:none;flex-direction:column;align-items:center;justify-content:center;',
        'padding:32px;background:rgba(255,255,255,.95);',
        'backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);}',
      '.tpm-close-confirm.tpm-visible{display:flex;}',
      '.tpm-close-confirm p{margin:0 0 20px;font-size:16px;font-weight:700;color:#000;text-align:center;max-width:260px;}',
      '.tpm-close-confirm-btns{display:flex;gap:8px;width:100%;max-width:300px;}',
      '.tpm-yes-close{flex:1;padding:12px;border-radius:80px;background:#000;color:#fff;border:none;',
        'font-family:inherit;font-size:14px;font-weight:600;cursor:pointer;}',
      '.tpm-keep-going{flex:1;padding:12px;border-radius:80px;background:#fff;color:#000;',
        'border:2px solid #e5e5e5;font-family:inherit;font-size:14px;font-weight:600;cursor:pointer;}',

      '.tpm-heading{font-size:20px;font-weight:700;margin:0 0 6px;line-height:1.2;color:#000;}',
      '.tpm-subtext{font-size:13px;color:#666;margin:0 0 20px;}',

      '.tpm-state-toggle{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px;}',
      '.tpm-state-btn{padding:18px 12px;border:2px solid #e5e5e5;border-radius:16px;background:#fff;',
        'color:#000;cursor:pointer;font-family:inherit;text-align:center;',
        'transition:border-color 150ms ease,background 150ms ease,color 150ms ease;}',
      '.tpm-state-btn:hover{border-color:#aaa;}',
      '.tpm-state-btn.tpm-active{background:#000;color:#fff;border-color:#000;}',
      '.tpm-state-abbr{display:block;font-size:22px;font-weight:800;line-height:1;margin-bottom:5px;}',
      '.tpm-state-name{display:block;font-size:12px;font-weight:400;opacity:.65;}',
      '.tpm-state-btn.tpm-active .tpm-state-name{opacity:.7;}',

      '.tpm-state-badge{display:inline-block;padding:6px 14px;background:#f5f5f5;border-radius:80px;',
        'font-size:13px;font-weight:700;color:#000;margin-bottom:14px;}',

      '.tpm-input{display:block;width:100%;padding:16px 18px;font-size:20px;font-weight:700;',
        'letter-spacing:.06em;font-family:inherit;border:2px solid #e5e5e5;border-radius:16px;',
        'background:#fff;color:#000;outline:none;transition:border-color 150ms ease;box-sizing:border-box;}',
      '.tpm-input:focus{border-color:#000;}',
      '.tpm-input.tpm-has-error{border-color:#e53e3e;}',

      '.tpm-input-sm{font-size:16px;letter-spacing:.03em;}',

      /* Locked-prefix DID input (Step 1) */
      '.tpm-did-wrap{display:flex;align-items:center;width:100%;padding:16px 18px;',
        'border:2px solid #e5e5e5;border-radius:16px;background:#fff;box-sizing:border-box;',
        'transition:border-color 150ms ease;cursor:text;}',
      '.tpm-did-wrap:focus-within{border-color:#000;}',
      '.tpm-did-wrap.tpm-has-error{border-color:#e53e3e;}',
      '.tpm-did-wrap.tpm-did-no-state{background:#f9f9f9;}',
      '.tpm-did-prefix{font-size:20px;font-weight:700;letter-spacing:.06em;color:#000;',
        'user-select:none;white-space:nowrap;flex-shrink:0;line-height:1;}',
      '.tpm-did-prefix.tpm-did-prefix-empty{color:#aaa;font-weight:400;}',
      '.tpm-did-suffix{flex:1;min-width:0;border:none;outline:none;padding:0;margin:0;',
        'font-size:20px;font-weight:700;letter-spacing:.06em;font-family:inherit;',
        'background:transparent;color:#000;}',
      '.tpm-did-suffix:disabled{cursor:not-allowed;}',
      '.tpm-did-suffix::placeholder{color:#aaa;font-weight:400;letter-spacing:.03em;}',

      '.tpm-error-msg{color:#e53e3e;font-size:14px;margin-top:8px;display:none;}',
      '.tpm-error-msg.tpm-visible{display:block;}',

      '.tpm-btn{display:block;width:100%;margin-top:14px;padding:0 15px;height:52px;',
        'font-size:15px;font-weight:700;font-family:inherit;border:none;border-radius:80px;',
        'cursor:pointer;transition:opacity 150ms ease,transform 150ms ease;text-align:center;}',
      '.tpm-btn:hover{opacity:.86;transform:translateY(-1px);}',
      '.tpm-btn:active{transform:none;opacity:1;}',
      '.tpm-btn:disabled{opacity:.7;cursor:not-allowed;transform:none;pointer-events:none;}',
      '.tpm-btn-green{background:#00D258;color:#fff;}',
      '.tpm-btn-black{background:#000;color:#fff;}',

      '.tpm-current-prison-box{font-size:13px;color:#666;margin-bottom:16px;padding:10px 14px;',
        'background:#f9f9f9;border-radius:12px;border:1px solid #e5e5e5;}',
      '.tpm-current-prison-box strong{color:#000;}',

      '.tpm-prison-grid{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:4px;}',
      '.tpm-prison-pill{padding:9px 16px;font-size:13px;font-weight:500;border:1.5px solid #e5e5e5;',
        'border-radius:80px;background:#fff;color:#000;cursor:pointer;font-family:inherit;',
        'transition:border-color 150ms ease,background 150ms ease,color 150ms ease;}',
      '.tpm-prison-pill:hover{border-color:#999;}',
      '.tpm-prison-pill.tpm-active{background:#000;color:#fff;border-color:#000;}',

      '.tpm-confirm-panel{position:sticky;bottom:0;z-index:1;margin-top:16px;',
        'padding:14px 0 0;background:#fff;border-top:1px solid #efefef;',
        'box-shadow:0 -20px 24px #fff;}',
      '.tpm-confirm-panel-label{font-size:13px;color:#666;font-weight:600;margin:0 0 8px;}',
      '.tpm-transfer-row{font-size:15px;font-weight:700;color:#000;margin-bottom:14px;}',
      '.tpm-transfer-arrow{color:#666;font-weight:400;margin:0 6px;}',
      '.tpm-change-link{background:none;border:none;color:#666;font-size:14px;font-family:inherit;',
        'cursor:pointer;text-decoration:underline;text-underline-offset:2px;',
        'margin-top:8px;display:block;padding:0;}',
      '.tpm-change-link:hover{color:#000;}',

      '.tpm-otp-sent-msg{font-size:13px;color:#1a7f4b;font-weight:600;margin-bottom:10px;}',
      '.tpm-resend-link{background:none;border:none;color:#666;font-size:13px;font-family:inherit;',
        'cursor:pointer;margin-top:10px;display:block;padding:0;}',
      '.tpm-resend-link span{text-decoration:underline;text-underline-offset:2px;}',
      '.tpm-resend-link:hover{color:#000;}',

      '.tpm-loading-wrap{text-align:center;padding:32px 0;}',
      '.tpm-spinner{display:inline-block;width:28px;height:28px;border:3px solid #e5e5e5;',
        'border-top-color:#00D258;border-radius:50%;animation:tpm-spin .7s linear infinite;',
        'margin-bottom:12px;}',
      '@keyframes tpm-spin{to{transform:rotate(360deg)}}',

      '.tpm-success-wrap{text-align:center;}',
      '.tpm-success-icon{width:56px;height:56px;background:#00D258;border-radius:50%;',
        'display:flex;align-items:center;justify-content:center;margin:0 auto 16px;',
        'font-size:28px;color:#fff;}',
      '.tpm-success-heading{font-size:20px;font-weight:700;margin:0 0 10px;color:#000;}',
      '.tpm-success-body{font-size:14px;color:#666;margin:0 0 20px;line-height:1.55;}',

      /* DEV TOOLS panel (staging only) */
      '.tpm-dev-panel{position:fixed;bottom:16px;right:16px;z-index:10001;',
        "background:#1a1a1a;color:#fff;padding:12px 14px;border-radius:10px;",
        "font-family:'Plus Jakarta Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;",
        'box-shadow:0 4px 20px rgba(0,0,0,.4);min-width:148px;}',
      '.tpm-dev-panel__title{font-size:9px;font-weight:700;letter-spacing:.12em;',
        'text-transform:uppercase;color:rgba(255,255,255,.38);margin-bottom:10px;}',
      '.tpm-dev-panel__row{display:flex;align-items:center;justify-content:space-between;',
        'gap:14px;margin-bottom:8px;}',
      '.tpm-dev-panel__row:last-child{margin-bottom:0;}',
      '.tpm-dev-panel__label{font-size:11px;font-weight:600;color:rgba(255,255,255,.82);}',
      '.tpm-dev-toggle{position:relative;display:inline-block;width:34px;height:19px;flex-shrink:0;}',
      '.tpm-dev-toggle input{opacity:0;width:0;height:0;position:absolute;}',
      '.tpm-dev-toggle__track{position:absolute;inset:0;background:#444;',
        'border-radius:10px;cursor:pointer;transition:background 150ms ease;}',
      '.tpm-dev-toggle__track::after{content:"";position:absolute;top:3px;left:3px;',
        'width:13px;height:13px;background:#fff;border-radius:50%;transition:transform 150ms ease;}',
      '.tpm-dev-toggle input:checked + .tpm-dev-toggle__track{background:#00D258;}',
      '.tpm-dev-toggle input:checked + .tpm-dev-toggle__track::after{transform:translateX(15px);}',
      '.tpm-dev-skip-btn{display:none;width:100%;margin-top:14px;padding:10px 15px;',
        'font-size:13px;font-weight:700;font-family:inherit;',
        'background:#1a1a1a;color:#00D258;border:2px solid #00D258;',
        'border-radius:80px;cursor:pointer;text-align:center;box-sizing:border-box;}',
      '.tpm-dev-skip-btn:hover{opacity:.85;}',

      '@media(max-width:768px){',
        '#tpm-card{max-height:95vh;padding:24px;border-radius:12px;}',
        '.tpm-close-confirm{border-radius:12px;padding:24px;}',
      '}',
    ].join('');
    document.head.appendChild(style);
  }

  /* ── HTML scaffold ────────────────────────────────────────────────────────── */
  function injectHTML() {
    overlay = document.createElement('div');
    overlay.id = 'tpm-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Transfer my prison');

    card = document.createElement('div');
    card.id = 'tpm-card';

    closeConfirmPanel = document.createElement('div');
    closeConfirmPanel.className = 'tpm-close-confirm';
    closeConfirmPanel.innerHTML =
      '<p>Are you sure? Your progress will be lost.</p>' +
      '<div class="tpm-close-confirm-btns">' +
        '<button class="tpm-yes-close" type="button">Yes, close</button>' +
        '<button class="tpm-keep-going" type="button">Keep going</button>' +
      '</div>';

    stepContent = document.createElement('div');
    stepContent.id = 'tpm-step-content';

    card.appendChild(closeConfirmPanel);
    card.appendChild(stepContent);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    closeConfirmPanel.querySelector('.tpm-yes-close').addEventListener('click', closeModal);
    closeConfirmPanel.querySelector('.tpm-keep-going').addEventListener('click', hideCloseConfirm);

    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) showCloseConfirm();
    });
  }

  /* ── Close-confirm helpers ────────────────────────────────────────────────── */
  function showCloseConfirm() {
    closeConfirmPanel.classList.add('tpm-visible');
  }

  function hideCloseConfirm() {
    closeConfirmPanel.classList.remove('tpm-visible');
  }

  /* ── Open / close ─────────────────────────────────────────────────────────── */
  function openModal() {
    hideCloseConfirm();
    overlay.classList.add('tpm-open');
    document.body.style.overflow = 'hidden';
    injectDevPanel();
    renderStep(1);
  }

  function closeModal() {
    overlay.classList.remove('tpm-open');
    document.body.style.overflow = '';
    removeDevPanel();
    resetState();
  }

  function resetState() {
    state.step = 1;
    state.selectedState = null;
    state.did = null;
    state.currentPrison = null;
    state.confirmedDid = null;
    state.mobile = null;
    state.selectedPrison = null;
    hideCloseConfirm();
  }

  /* ── Step renderer ────────────────────────────────────────────────────────── */
  function renderStep(n) {
    state.step = n;
    hideCloseConfirm();
    stepContent.innerHTML = '';

    /* Header row */
    var header = document.createElement('div');
    header.className = 'tpm-header';

    var backBtn = document.createElement('button');
    backBtn.className = 'tpm-back';
    backBtn.type = 'button';
    backBtn.textContent = '\u2190 Back';
    backBtn.addEventListener('click', function () {
      if (n === 1) {
        showCloseConfirm();
      } else {
        goBack(n);
      }
    });

    var headerRight = document.createElement('div');
    headerRight.className = 'tpm-header-right';

    var closeBtn = document.createElement('button');
    closeBtn.className = 'tpm-close-btn';
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close modal');
    closeBtn.textContent = '\u00D7';
    closeBtn.addEventListener('click', showCloseConfirm);

    var stepInd = document.createElement('span');
    stepInd.className = 'tpm-step-ind';
    stepInd.textContent = 'Step ' + n + ' of 5';

    headerRight.appendChild(closeBtn);
    headerRight.appendChild(stepInd);
    header.appendChild(backBtn);
    header.appendChild(headerRight);
    stepContent.appendChild(header);

    /* Step body */
    var body = document.createElement('div');
    stepContent.appendChild(body);

    if (n === 1) buildStep1(body);
    else if (n === 2) buildStep2(body);
    else if (n === 3) buildStep3(body);
    else if (n === 4) buildStep4(body);
    else if (n === 5) buildStep5(body, backBtn);
  }

  function goBack(n) {
    if (n === 2) renderStep(1);
    else if (n === 3) renderStep(2);
    else if (n === 4) {
      /* Clear OTP state when returning to step 3 */
      state.mobile = null;
      renderStep(3);
    }
    /* No back from step 5 */
  }

  /* ── Step 1 — Enter Prisoncall number ────────────────────────────────────── */
  function buildStep1(body) {
    body.innerHTML =
      '<h2 class="tpm-heading">Enter your current Prisoncall number</h2>' +
      '<p class="tpm-subtext">This is the local number your loved one calls.</p>';

    /* State toggle */
    var toggle = document.createElement('div');
    toggle.className = 'tpm-state-toggle';

    var vicBtn = makeStateBtn('VIC', 'Victoria', state.selectedState === 'vic');
    var nswBtn = makeStateBtn('NSW', 'New South Wales', state.selectedState === 'nsw');
    toggle.appendChild(vicBtn);
    toggle.appendChild(nswBtn);
    body.appendChild(toggle);

    /* Split prefix + suffix input */
    var didWrap = document.createElement('div');
    didWrap.className = 'tpm-did-wrap' + (!state.selectedState ? ' tpm-did-no-state' : '');

    var prefixSpan = document.createElement('span');
    prefixSpan.className = 'tpm-did-prefix' + (!state.selectedState ? ' tpm-did-prefix-empty' : '');
    prefixSpan.textContent = state.selectedState === 'vic' ? '03'
      : state.selectedState === 'nsw' ? '02'
      : '0?';

    var suffixInput = document.createElement('input');
    suffixInput.type = 'tel';
    suffixInput.inputMode = 'numeric';
    suffixInput.setAttribute('pattern', '[0-9]*');
    suffixInput.setAttribute('autocomplete', 'off');
    suffixInput.setAttribute('autocorrect', 'off');
    suffixInput.setAttribute('autocapitalize', 'off');
    suffixInput.setAttribute('spellcheck', 'false');
    suffixInput.className = 'tpm-did-suffix';
    suffixInput.maxLength = 8;
    suffixInput.disabled = !state.selectedState;
    suffixInput.placeholder = state.selectedState ? 'XXXXXXXX' : 'Select a state first';

    /* Restore suffix when navigating back */
    if (state.did && state.selectedState) {
      var savedPrefix = state.selectedState === 'vic' ? '03' : '02';
      suffixInput.value = state.did.startsWith(savedPrefix)
        ? state.did.slice(2)
        : state.did.slice(2);
    }

    /* Click on the wrapper focuses the input */
    didWrap.addEventListener('click', function () { suffixInput.focus(); });

    didWrap.appendChild(prefixSpan);
    didWrap.appendChild(suffixInput);
    body.appendChild(didWrap);

    var errorEl = document.createElement('p');
    errorEl.className = 'tpm-error-msg';
    body.appendChild(errorEl);

    var continueBtn = document.createElement('button');
    continueBtn.className = 'tpm-btn tpm-btn-green';
    continueBtn.type = 'button';
    continueBtn.textContent = 'Continue';
    body.appendChild(continueBtn);

    function setActiveState(st) {
      state.selectedState = st;
      vicBtn.className = 'tpm-state-btn' + (st === 'vic' ? ' tpm-active' : '');
      nswBtn.className = 'tpm-state-btn' + (st === 'nsw' ? ' tpm-active' : '');
      prefixSpan.textContent = st === 'vic' ? '03' : '02';
      prefixSpan.classList.remove('tpm-did-prefix-empty');
      suffixInput.disabled = false;
      suffixInput.placeholder = 'XXXXXXXX';
      suffixInput.value = '';
      didWrap.classList.remove('tpm-did-no-state', 'tpm-has-error');
      errorEl.classList.remove('tpm-visible');
      errorEl.textContent = '';
      suffixInput.focus();
    }

    vicBtn.addEventListener('click', function () { setActiveState('vic'); });
    nswBtn.addEventListener('click', function () { setActiveState('nsw'); });

    /* Digits only, max 8 — also handles full-number paste/autofill from mobile */
    suffixInput.addEventListener('input', function () {
      var digits = suffixInput.value.replace(/\D/g, '');
      /* If mobile autofilled/pasted the full 10-digit number, strip the state prefix */
      if (digits.length > 8 && state.selectedState) {
        var statePrefix = state.selectedState === 'vic' ? '03' : '02';
        if (digits.startsWith(statePrefix)) digits = digits.slice(2);
      }
      suffixInput.value = digits.slice(0, 8);
      didWrap.classList.remove('tpm-has-error');
      errorEl.classList.remove('tpm-visible');
      errorEl.textContent = '';
    });

    continueBtn.addEventListener('click', function () {
      if (!state.selectedState) {
        didWrap.classList.add('tpm-has-error');
        errorEl.textContent = 'Please select a state first.';
        errorEl.classList.add('tpm-visible');
        return;
      }

      var prefix = state.selectedState === 'vic' ? '03' : '02';
      var stateLabel = state.selectedState === 'vic' ? 'VIC' : 'NSW';
      var suffix = suffixInput.value.replace(/\D/g, '');
      /* Defensive: handle full-number paste that may have bypassed the input event */
      if (suffix.length > 8 && suffix.startsWith(prefix)) suffix = suffix.slice(prefix.length);
      suffix = suffix.slice(0, 8);

      if (suffix.length !== 8) {
        didWrap.classList.add('tpm-has-error');
        errorEl.textContent = 'Please enter all 8 digits for your ' + stateLabel + ' Prisoncall number.';
        errorEl.classList.add('tpm-visible');
        suffixInput.focus();
        return;
      }

      var fullNumber = prefix + suffix;
      console.log('[TPM] Sending DID:', fullNumber, '| raw suffix field:', JSON.stringify(suffixInput.value));

      setLoading(continueBtn, 'Checking...');
      didWrap.classList.remove('tpm-has-error');
      errorEl.classList.remove('tpm-visible');

      fetch('/api/check-did', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ did: fullNumber }),
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.success) {
            state.did = fullNumber;
            state.currentPrison = data.currentPrison;
            if (data.state) state.selectedState = data.state.toLowerCase();
            renderStep(2);
          } else {
            restoreBtn(continueBtn, 'Continue');
            didWrap.classList.add('tpm-has-error');
            errorEl.textContent =
              "We couldn't find an active Prisoncall number matching those details. Please check and try again.";
            errorEl.classList.add('tpm-visible');
          }
        })
        .catch(function () {
          restoreBtn(continueBtn, 'Continue');
          didWrap.classList.add('tpm-has-error');
          errorEl.textContent =
            "We couldn't find an active Prisoncall number matching those details. Please check and try again.";
          errorEl.classList.add('tpm-visible');
        });
    });

    suffixInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); continueBtn.click(); }
    });
  }

  /* ── Step 2 — Reconfirm Prisoncall number ────────────────────────────────── */
  function buildStep2(body) {
    var stateLabel = state.selectedState === 'vic' ? 'VIC' : 'NSW';
    var prefix = state.selectedState === 'vic' ? '03' : '02';

    body.innerHTML =
      '<h2 class="tpm-heading">Confirm your Prisoncall number</h2>' +
      '<p class="tpm-subtext">Please re-enter your number to confirm.</p>';

    var badge = document.createElement('span');
    badge.className = 'tpm-state-badge';
    badge.textContent = stateLabel;
    body.appendChild(badge);

    var input = document.createElement('input');
    input.className = 'tpm-input';
    input.type = 'tel';
    input.inputMode = 'numeric';
    input.maxLength = 10;
    input.placeholder = prefix + 'XXXXXXXX';
    input.value = state.confirmedDid || '';
    body.appendChild(input);

    var errorEl = document.createElement('p');
    errorEl.className = 'tpm-error-msg';
    body.appendChild(errorEl);

    var continueBtn = document.createElement('button');
    continueBtn.className = 'tpm-btn tpm-btn-green';
    continueBtn.type = 'button';
    continueBtn.textContent = 'Continue';
    body.appendChild(continueBtn);

    input.addEventListener('input', function () {
      input.value = input.value.replace(/\D/g, '').slice(0, 10);
      clearError(input, errorEl);
    });

    continueBtn.addEventListener('click', function () {
      var val = input.value.replace(/\D/g, '');
      if (val.length !== 10 || !val.startsWith(prefix)) {
        showError(input, errorEl, 'Please enter a valid Prisoncall number for ' + stateLabel + '.');
        return;
      }
      if (val !== state.did) {
        showError(input, errorEl, "The numbers don't match. Please try again.");
        return;
      }
      state.confirmedDid = val;
      renderStep(3);
    });

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); continueBtn.click(); }
    });
  }

  /* ── Step 3 — Verify mobile (OTP) ────────────────────────────────────────── */
  function buildStep3(body) {
    body.innerHTML =
      '<h2 class="tpm-heading">Verify your mobile number</h2>' +
      '<p class="tpm-subtext">Enter your mobile number. Don\'t enter your assigned mobile number as it may vary if you have multiple plans.</p>';

    /* -- Phase A: mobile entry + Send Code -- */
    var mobileWrap = document.createElement('div');

    var mobileInput = document.createElement('input');
    mobileInput.className = 'tpm-input tpm-input-sm';
    mobileInput.type = 'tel';
    mobileInput.inputMode = 'numeric';
    mobileInput.maxLength = 12;
    mobileInput.placeholder = '04XX XXX XXX';
    mobileInput.value = state.mobile ? formatMobile(state.mobile) : '';

    var mobileError = document.createElement('p');
    mobileError.className = 'tpm-error-msg';

    var sendBtn = document.createElement('button');
    sendBtn.className = 'tpm-btn tpm-btn-green';
    sendBtn.type = 'button';
    sendBtn.textContent = 'Send Code';

    mobileWrap.appendChild(mobileInput);
    mobileWrap.appendChild(mobileError);
    mobileWrap.appendChild(sendBtn);
    body.appendChild(mobileWrap);

    /* -- Phase B: OTP entry -- */
    var otpWrap = document.createElement('div');
    otpWrap.style.display = 'none';
    body.appendChild(otpWrap);

    /* Mobile auto-format on input */
    mobileInput.addEventListener('input', function () {
      var raw = mobileInput.value.replace(/\D/g, '').slice(0, 10);
      var fmt = raw;
      if (raw.length > 7) fmt = raw.slice(0, 4) + ' ' + raw.slice(4, 7) + ' ' + raw.slice(7);
      else if (raw.length > 4) fmt = raw.slice(0, 4) + ' ' + raw.slice(4);
      mobileInput.value = fmt;
      clearError(mobileInput, mobileError);
    });

    function getCleanMobile() {
      return mobileInput.value.replace(/\D/g, '');
    }

    /* Phase B builder */
    function showOtpPhase(cleanMobile) {
      mobileWrap.style.display = 'none';
      otpWrap.style.display = 'block';
      otpWrap.innerHTML = '';

      var sentMsg = document.createElement('p');
      sentMsg.className = 'tpm-otp-sent-msg';
      sentMsg.innerHTML = '\u2713 Code sent to <strong>' + esc(maskMobile(cleanMobile)) + '</strong>';
      otpWrap.appendChild(sentMsg);

      var codeInput = document.createElement('input');
      codeInput.className = 'tpm-input tpm-input-sm';
      codeInput.type = 'tel';
      codeInput.inputMode = 'numeric';
      codeInput.placeholder = '000000';
      codeInput.maxLength = 6;
      codeInput.setAttribute('autocomplete', 'one-time-code');
      otpWrap.appendChild(codeInput);

      var codeError = document.createElement('p');
      codeError.className = 'tpm-error-msg';
      otpWrap.appendChild(codeError);

      var verifyBtn = document.createElement('button');
      verifyBtn.className = 'tpm-btn tpm-btn-green';
      verifyBtn.type = 'button';
      verifyBtn.textContent = 'Verify';
      otpWrap.appendChild(verifyBtn);

      var resendLink = document.createElement('button');
      resendLink.className = 'tpm-resend-link';
      resendLink.type = 'button';
      resendLink.innerHTML = "Didn't get a code? <span>Resend</span>";
      otpWrap.appendChild(resendLink);

      codeInput.addEventListener('input', function () {
        codeInput.value = codeInput.value.replace(/\D/g, '').slice(0, 6);
        clearError(codeInput, codeError);
      });

      resendLink.addEventListener('click', function () {
        var origHTML = resendLink.innerHTML;
        codeInput.value = '';
        clearError(codeInput, codeError);
        resendLink.disabled = true;
        resendLink.textContent = 'Sending...';

        fetch('/send-otp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mobile: cleanMobile }),
        })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            resendLink.disabled = false;
            if (data.success) {
              resendLink.textContent = 'Code resent.';
              setTimeout(function () { resendLink.innerHTML = origHTML; }, 2500);
            } else {
              resendLink.innerHTML = origHTML;
            }
            codeInput.focus();
          })
          .catch(function () {
            resendLink.disabled = false;
            resendLink.innerHTML = origHTML;
            codeInput.focus();
          });
      });

      function doVerify() {
        var code = codeInput.value.replace(/\D/g, '').replace(/\s+/g, '');
        if (code.length < 6) {
          showError(codeInput, codeError, 'Please enter the full 6-digit code.');
          return;
        }

        /* DEV bypass: staging only — 111111 skips Twilio + mobile check */
        if (window.location.hostname === 'prisoncall.pages.dev' && code === '111111') {
          state.mobile = cleanMobile;
          renderStep(4);
          return;
        }

        setLoading(verifyBtn, 'Verifying...');

        fetch('/verify-otp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mobile: cleanMobile, code: code }),
        })
          .then(function (r) { return r.json(); })
          .then(function (otpData) {
            if (!otpData.success) {
              restoreBtn(verifyBtn, 'Verify');
              showError(codeInput, codeError, otpData.error || 'Incorrect code. Please try again.');
              return;
            }
            state.mobile = cleanMobile;
            renderStep(4);
          })
          .catch(function () {
            restoreBtn(verifyBtn, 'Verify');
            showError(codeInput, codeError, 'Incorrect code. Please try again.');
          });
      }

      verifyBtn.addEventListener('click', doVerify);
      codeInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); doVerify(); }
      });
      codeInput.focus();
    }

    /* Send Code click */
    sendBtn.addEventListener('click', function () {
      var cleanMobile = getCleanMobile();
      if (!/^04\d{8}$/.test(cleanMobile)) {
        showError(mobileInput, mobileError,
          'Please enter a valid Australian mobile number (e.g. 0412 345 678).');
        return;
      }

      setLoading(sendBtn, 'Sending...');
      clearError(mobileInput, mobileError);

      /* Step 1: cross-check mobile against Supabase before sending any SMS */
      fetch('/api/check-mobile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ did: state.did, mobile: cleanMobile }),
      })
        .then(function (r) { return r.json(); })
        .then(function (checkData) {
          if (!checkData.success) {
            restoreBtn(sendBtn, 'Send Code');
            showError(mobileInput, mobileError,
              'This mobile number does not match the account for this Prisoncall number.');
            return;
          }
          /* Step 2: mobile verified — now trigger Twilio OTP */
          fetch('/send-otp', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mobile: cleanMobile }),
          })
            .then(function (r) { return r.json(); })
            .then(function (data) {
              if (data.success) {
                showOtpPhase(cleanMobile);
              } else {
                restoreBtn(sendBtn, 'Send Code');
                showError(mobileInput, mobileError, 'Failed to send code. Please try again.');
              }
            })
            .catch(function () {
              restoreBtn(sendBtn, 'Send Code');
              showError(mobileInput, mobileError, 'Failed to send code. Please try again.');
            });
        })
        .catch(function () {
          restoreBtn(sendBtn, 'Send Code');
          showError(mobileInput, mobileError, 'Failed to send code. Please try again.');
        });
    });

    /* DEV TOOLS — Skip Step 3 button (staging only) */
    if (window.location.hostname === 'prisoncall.pages.dev') {
      var devSkipBtn = document.createElement('button');
      devSkipBtn.id = 'tpm-dev-skip-step3-btn';
      devSkipBtn.className = 'tpm-dev-skip-btn';
      devSkipBtn.type = 'button';
      devSkipBtn.textContent = 'Skip Step 3 (DEV)';
      devSkipBtn.style.display = devSkipStep3 ? 'block' : 'none';
      devSkipBtn.addEventListener('click', function () {
        state.mobile = '0400000000';
        renderStep(4);
      });
      body.appendChild(devSkipBtn);
    }
  }

  /* ── Step 4 — Select new prison ──────────────────────────────────────────── */
  function buildStep4(body) {
    body.innerHTML =
      '<h2 class="tpm-heading">Select your new prison</h2>' +
      '<p class="tpm-subtext">Choose the prison your loved one has moved to.</p>';

    var currentBox = document.createElement('div');
    currentBox.className = 'tpm-current-prison-box';
    currentBox.innerHTML = 'Current prison: <strong>' + esc(state.currentPrison) + '</strong>';
    body.appendChild(currentBox);

    /* State toggle - pre-select the DID's state */
    var activeState = state.selectedState || 'vic';

    var toggle = document.createElement('div');
    toggle.className = 'tpm-state-toggle';

    var vicBtn = makeStateBtn('VIC', 'Victoria', activeState === 'vic');
    var nswBtn = makeStateBtn('NSW', 'New South Wales', activeState === 'nsw');
    toggle.appendChild(vicBtn);
    toggle.appendChild(nswBtn);
    body.appendChild(toggle);

    /* Prison grid */
    var prisonGrid = document.createElement('div');
    prisonGrid.className = 'tpm-prison-grid';
    body.appendChild(prisonGrid);

    var prisonError = document.createElement('p');
    prisonError.className = 'tpm-error-msg';
    body.appendChild(prisonError);

    /* Confirm panel (shown after pill click) */
    var confirmPanel = document.createElement('div');
    confirmPanel.className = 'tpm-confirm-panel';
    confirmPanel.style.display = 'none';
    body.appendChild(confirmPanel);

    function buildPills(stateVal) {
      prisonGrid.innerHTML = '';
      var prisons = PRISONS[stateVal] || [];
      prisons.forEach(function (p) {
        var pill = document.createElement('button');
        pill.className = 'tpm-prison-pill' + (p === state.selectedPrison ? ' tpm-active' : '');
        pill.type = 'button';
        pill.textContent = p;
        prisonGrid.appendChild(pill);

        pill.addEventListener('click', function () {
          prisonError.classList.remove('tpm-visible');

          if (p === state.currentPrison) {
            prisonGrid.querySelectorAll('.tpm-prison-pill').forEach(function (pp) {
              pp.classList.remove('tpm-active');
            });
            state.selectedPrison = null;
            confirmPanel.style.display = 'none';
            prisonError.textContent = 'This is already your current prison.';
            prisonError.classList.add('tpm-visible');
            return;
          }

          prisonGrid.querySelectorAll('.tpm-prison-pill').forEach(function (pp) {
            pp.classList.remove('tpm-active');
          });
          pill.classList.add('tpm-active');
          state.selectedPrison = p;

          /* Show confirm panel */
          confirmPanel.style.display = 'block';
          confirmPanel.innerHTML =
            '<p class="tpm-confirm-panel-label">Confirm your transfer:</p>' +
            '<div class="tpm-transfer-row">' +
              esc(state.currentPrison) +
              '<span class="tpm-transfer-arrow"> -&gt; </span>' +
              esc(p) +
            '</div>';

          var confirmTransferBtn = document.createElement('button');
          confirmTransferBtn.className = 'tpm-btn tpm-btn-green';
          confirmTransferBtn.type = 'button';
          confirmTransferBtn.textContent = 'Confirm transfer';
          confirmTransferBtn.style.marginTop = '0';
          confirmTransferBtn.addEventListener('click', function () {
            renderStep(5);
          });
          confirmPanel.appendChild(confirmTransferBtn);

          var changeLink = document.createElement('button');
          changeLink.className = 'tpm-change-link';
          changeLink.type = 'button';
          changeLink.textContent = 'Change selection';
          changeLink.addEventListener('click', function () {
            state.selectedPrison = null;
            confirmPanel.style.display = 'none';
            prisonGrid.querySelectorAll('.tpm-prison-pill').forEach(function (pp) {
              pp.classList.remove('tpm-active');
            });
          });
          confirmPanel.appendChild(changeLink);
        });
      });
    }

    function setActiveState(st) {
      activeState = st;
      vicBtn.className = 'tpm-state-btn' + (st === 'vic' ? ' tpm-active' : '');
      nswBtn.className = 'tpm-state-btn' + (st === 'nsw' ? ' tpm-active' : '');
      state.selectedPrison = null;
      confirmPanel.style.display = 'none';
      prisonError.classList.remove('tpm-visible');
      buildPills(st);
    }

    vicBtn.addEventListener('click', function () { setActiveState('vic'); });
    nswBtn.addEventListener('click', function () { setActiveState('nsw'); });

    buildPills(activeState);

    /* Re-trigger selected prison if navigating back */
    if (state.selectedPrison) {
      var match = null;
      prisonGrid.querySelectorAll('.tpm-prison-pill').forEach(function (pill) {
        if (pill.textContent === state.selectedPrison) match = pill;
      });
      if (match) match.click();
    }
  }

  /* ── Step 5 — Submit and confirm ─────────────────────────────────────────── */
  function buildStep5(body, backBtn) {
    /* Step 5 has no back button */
    if (backBtn) backBtn.style.display = 'none';

    body.innerHTML =
      '<div class="tpm-loading-wrap">' +
        '<div class="tpm-spinner"></div>' +
        '<p style="color:#666;font-size:14px;margin:0;">Submitting your request...</p>' +
      '</div>';

    function doSubmit() {
      fetch('/api/submit-transfer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          did: state.did,
          currentPrison: state.currentPrison,
          newPrison: state.selectedPrison,
          mobile: state.mobile,
          currentState: state.selectedState,
        }),
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.success) {
            showSuccess(body);
          } else {
            showRetry(body, backBtn, doSubmit);
          }
        })
        .catch(function () {
          showRetry(body, backBtn, doSubmit);
        });
    }

    doSubmit();
  }

  function showSuccess(body) {
    body.innerHTML =
      '<div class="tpm-success-wrap">' +
        '<div class="tpm-success-icon">\u2713</div>' +
        '<p class="tpm-success-heading">Transfer request submitted</p>' +
        '<p class="tpm-success-body">We\'ve sent you an SMS to confirm your transfer request. ' +
          'Please reply YES to proceed or NO to cancel. This request expires in 24 hours.</p>' +
      '</div>';

    var doneBtn = document.createElement('button');
    doneBtn.className = 'tpm-btn tpm-btn-green';
    doneBtn.type = 'button';
    doneBtn.textContent = 'Done';
    doneBtn.addEventListener('click', closeModal);
    body.appendChild(doneBtn);
  }

  function showRetry(body, backBtn, retryFn) {
    body.innerHTML =
      '<h2 class="tpm-heading">Something went wrong</h2>' +
      '<p class="tpm-subtext">Your request could not be submitted.</p>' +
      '<p class="tpm-error-msg tpm-visible" style="margin-bottom:14px;">Something went wrong. Please try again.</p>';

    var retryBtn = document.createElement('button');
    retryBtn.className = 'tpm-btn tpm-btn-green';
    retryBtn.type = 'button';
    retryBtn.textContent = 'Retry';
    retryBtn.addEventListener('click', function () {
      body.innerHTML =
        '<div class="tpm-loading-wrap">' +
          '<div class="tpm-spinner"></div>' +
          '<p style="color:#666;font-size:14px;margin:0;">Submitting your request...</p>' +
        '</div>';
      retryFn();
    });
    body.appendChild(retryBtn);
  }

  /* ── State button factory ─────────────────────────────────────────────────── */
  function makeStateBtn(abbr, name, isActive) {
    var btn = document.createElement('button');
    btn.className = 'tpm-state-btn' + (isActive ? ' tpm-active' : '');
    btn.type = 'button';
    btn.innerHTML =
      '<span class="tpm-state-abbr">' + abbr + '</span>' +
      '<span class="tpm-state-name">' + name + '</span>';
    return btn;
  }

  /* ── Trigger wiring ───────────────────────────────────────────────────────── */
  function wireTriggers() {
    document.addEventListener('click', function (e) {
      var t = e.target.closest('[data-transfer-prison], .transfer-prison-trigger');
      if (t) {
        e.preventDefault();
        openModal();
      }
    });
  }

  /* ── Keyboard: Escape closes (with confirm) ──────────────────────────────── */
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && overlay && overlay.classList.contains('tpm-open')) {
      showCloseConfirm();
    }
  });

  /* ── Init ─────────────────────────────────────────────────────────────────── */
  function init() {
    injectCSS();
    injectHTML();
    wireTriggers();
    window.tpmOpenModal = openModal;
    if (window.location.hash === '#transfer-prison') {
      openModal();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();

window.addEventListener('hashchange', function () {
  if (window.location.hash === '#transfer-prison' && typeof window.tpmOpenModal === 'function') {
    window.tpmOpenModal();
  }
});
