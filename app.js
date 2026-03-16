  /* ════════════════════════════════════════════════════════════════
     CONFIGURATION
  ════════════════════════════════════════════════════════════════ */
  var CONFIG = {
    // LocationIQ token — get yours free at locationiq.com (no credit card needed)
    // Used for both address autocomplete AND road distance calculation.
    LOCATIONIQ_TOKEN: 'pk.ec47de1300ad77f86deab165cce9bbe2',

    // Capperberry pickup coords — update if the location changes
    CAPPERBERRY_LNG: 3.3792,
    CAPPERBERRY_LAT: 6.5244,

    // Pricing: fee = BASE + RATE_PER_KM * km  (road distance, not straight-line)
    BASE_DELIVERY_FEE: 1000,
    RATE_PER_KM:       200,

    // Google Apps Script endpoint — writes orders to Google Sheet
    ORDERS_API_URL: 'https://script.google.com/macros/s/AKfycbyOyLXDiJ24ba0_psEqgCutQ3imIoJ5TDktOhzxKrQ2Ye14MIX9XyM0Web3QpoQB-YU/exec',

    // Vendor slug — must match the sheet tab name in Google Sheets
    VENDOR_SLUG: 'capperberry',

    // Autocomplete: wait this many ms after last keystroke before fetching
    DEBOUNCE_MS: 350,
    // Min chars before autocomplete fires
    MIN_CHARS: 3,
  };

  /* ════════════════════════════════════════════════════════════════
     MOCK DATABASE
  ════════════════════════════════════════════════════════════════ */
  var MOCK_DB = {
    '08011111111': { firstName: 'Amara',  lastName: 'Okonkwo', email: 'amara@email.com',  address: '14 Banana Island Road, Ikoyi' },
    '08022222222': { firstName: 'Chidi',  lastName: 'Nwoke',   email: 'chidi@email.com',  address: '5 Admiralty Way, Lekki Phase 1' },
    '08033333333': { firstName: 'Fatima', lastName: 'Bello',   email: 'fatima@email.com', address: '22 Adeola Odeku, Victoria Island' },
  };

  /* ─── APP STATE ─── */
  var SERVICES = [
    { id: 'express', name: 'Express Wash', price: 300, qty: 0 },
    { id: 'fold',    name: 'Wash + Fold',  price: 300, qty: 0 },
    { id: 'iron',    name: 'Wash + Iron',  price: 300, qty: 0 },
    { id: 'dry',     name: 'Dry-clean',    price: 300, qty: 0 },
  ];

  var currentUser          = null;
  var isNewCustomer        = false;
  var orderId              = '';
  var deliveryFee          = CONFIG.BASE_DELIVERY_FEE;
  var deliveryLabel        = 'Calculating...';
  var selectedAddress      = '';      // full_address string from Mapbox
  var selectedCoords       = null;    // { lng, lat }
  var addressConfirmed     = false;
  var debounceTimer        = null;

  function genOrderId() {
    return 'ORD-' + Date.now().toString(36).toUpperCase();
  }

  /* ════════════════════════════════════════════════════════════════
     LOCATIONIQ ADDRESS AUTOCOMPLETE
     Uses LocationIQ Autocomplete API — Lagos-biased, Nigeria only.
     Debounces keystrokes and requires MIN_CHARS before fetching.
     Free tier: 5,000 requests/day — no credit card needed.
  ════════════════════════════════════════════════════════════════ */
  function initMapboxAutocomplete() {
    var input    = document.getElementById('new-addr');
    var dropdown = document.getElementById('addr-dropdown');
    if (!input || !dropdown) return;

    input.addEventListener('input', function() {
      addressConfirmed = false;
      selectedAddress  = '';
      selectedCoords   = null;
      setAddrStatus('', '');
      deliveryFee   = CONFIG.BASE_DELIVERY_FEE;
      deliveryLabel = 'Calculating...';

      clearTimeout(debounceTimer);
      var q = input.value.trim();
      if (q.length < CONFIG.MIN_CHARS) { hideDropdown(); return; }

      debounceTimer = setTimeout(function() { fetchSuggestions(q); }, CONFIG.DEBOUNCE_MS);
    });

    document.addEventListener('click', function(e) {
      if (!input.contains(e.target) && !dropdown.contains(e.target)) hideDropdown();
    });

    input.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') hideDropdown();
    });
  }

  function fetchSuggestions(query) {
    var url = 'https://api.locationiq.com/v1/autocomplete'
      + '?key='             + CONFIG.LOCATIONIQ_TOKEN
      + '&q='               + encodeURIComponent(query)
      + '&countrycodes=ng'
      + '&limit=5'
      + '&dedupe=1'
      + '&proximity_lat='   + CONFIG.CAPPERBERRY_LAT
      + '&proximity_lon='   + CONFIG.CAPPERBERRY_LNG
      + '&tag=place:house,place:city,place:suburb,highway:residential,highway:primary';

    fetch(url)
      .then(function(r) { return r.json(); })
      .then(function(data) {
        var results = Array.isArray(data) ? data : [];
        renderDropdown(results);
      })
      .catch(function() { hideDropdown(); });
  }

  function renderDropdown(results) {
    var dropdown = document.getElementById('addr-dropdown');
    if (!results.length) { hideDropdown(); return; }

    dropdown.innerHTML = results.map(function(r, i) {
      var display = r.display_name || '';
      var parts   = display.split(',');
      var main    = parts[0].trim();
      var secondary = parts.slice(1).join(',').trim();
      return '<div class="addr-item" data-idx="' + i + '">'
        + '<span class="addr-item-main">' + escHtml(main) + '</span>'
        + (secondary ? '<span class="addr-item-sub">' + escHtml(secondary) + '</span>' : '')
        + '</div>';
    }).join('');

    dropdown.querySelectorAll('.addr-item').forEach(function(el, i) {
      el.addEventListener('click', function() {
        selectSuggestion(results[i]);
      });
    });

    dropdown.style.display = 'block';
  }

  function selectSuggestion(result) {
    var full = result.display_name || '';
    var lat  = parseFloat(result.lat);
    var lon  = parseFloat(result.lon);

    selectedAddress  = full;
    selectedCoords   = { lng: lon, lat: lat };
    addressConfirmed = true;

    document.getElementById('new-addr').value = full;
    hideDropdown();

    calculateDeliveryFee(selectedCoords);
  }

  function hideDropdown() {
    var dropdown = document.getElementById('addr-dropdown');
    if (dropdown) dropdown.style.display = 'none';
  }

  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ════════════════════════════════════════════════════════════════
     DELIVERY FEE CALCULATION
     Uses LocationIQ Directions API directly from the frontend.
     No backend worker needed — one token handles everything.
     Road distance (driving) from Capperberry → customer address.
  ════════════════════════════════════════════════════════════════ */
  function calculateDeliveryFee(coords) {
    setAddrStatus('Calculating...', 'loading');

    var url = 'https://us1.locationiq.com/v1/directions/driving/'
      + CONFIG.CAPPERBERRY_LNG + ',' + CONFIG.CAPPERBERRY_LAT + ';'
      + coords.lng + ',' + coords.lat
      + '?key=' + CONFIG.LOCATIONIQ_TOKEN
      + '&overview=false';

    fetch(url)
      .then(function(r) {
        if (!r.ok) throw new Error('Network error');
        return r.json();
      })
      .then(function(data) {
        var routes  = data.routes;
        if (!routes || !routes.length) throw new Error('No route found');
        var metres  = routes[0].distance;
        var km      = parseFloat((metres / 1000).toFixed(1));
        deliveryFee   = Math.round(CONFIG.BASE_DELIVERY_FEE + CONFIG.RATE_PER_KM * km);
        deliveryLabel = km + ' km';
        setAddrStatus('\u2713 ' + km + ' km away', 'ok');
      })
      .catch(function() {
        deliveryFee   = CONFIG.BASE_DELIVERY_FEE;
        deliveryLabel = 'Could not calculate';
        setAddrStatus('Could not calculate distance', 'err');
      });
  }

  function setAddrStatus(text, type) {
    var el = document.getElementById('addr-status');
    if (!el) return;
    el.textContent = text;
    el.className   = 'addr-status' + (type ? ' ' + type : '');
  }

  /* ─── NAVIGATION ─── */
  function go(screenId) {
    document.querySelectorAll('.screen').forEach(function(s) { s.classList.remove('active'); });
    document.getElementById(screenId).classList.add('active');
    window.scrollTo(0, 0);
    if (screenId === 's-order')   renderOrderScreen();
    if (screenId === 's-summary') renderSummary();
  }

  /* ─── STEP 1: CHECK PHONE ─── */
  function checkPhone() {
    var input = document.getElementById('phone-input');
    var err   = document.getElementById('phone-error');
    var phone = input.value.trim().replace(/\s+/g, '');

    if (phone.length < 7) {
      input.classList.add('input-error');
      err.style.display = 'block';
      return;
    }
    input.classList.remove('input-error');
    err.style.display = 'none';
    go('s-checking');

    setTimeout(function() {
      var found = MOCK_DB[phone];
      if (found) {
        currentUser   = Object.assign({}, found, { phone: phone });
        isNewCustomer = false;
        go('s-order');
      } else {
        currentUser      = { phone: phone, firstName: '', lastName: '', email: '', address: '' };
        isNewCustomer    = true;
        addressConfirmed = false;
        selectedAddress  = '';
        selectedCoords   = null;
        deliveryFee      = CONFIG.BASE_DELIVERY_FEE;
        deliveryLabel    = 'Calculating...';
        go('s-new');
      }
    }, 1200);
  }

  /* ─── STEP 2a: NEW CUSTOMER SUBMIT ─── */
  function submitNewCustomer() {
    var nameInput = document.getElementById('new-name');
    var addrInput = document.getElementById('new-addr');
    var nameVal   = nameInput.value.trim();
    var valid     = true;

    if (!nameVal) {
      nameInput.classList.add('input-error');
      document.getElementById('new-name-error').style.display = 'block';
      valid = false;
    } else {
      nameInput.classList.remove('input-error');
      document.getElementById('new-name-error').style.display = 'none';
    }

    if (!addressConfirmed || !selectedAddress) {
      addrInput.classList.add('input-error');
      var addrErr = document.getElementById('new-addr-error');
      addrErr.textContent   = 'Please select an address from the suggestions';
      addrErr.style.display = 'block';
      valid = false;
    } else {
      addrInput.classList.remove('input-error');
      document.getElementById('new-addr-error').style.display = 'none';
    }

    if (!valid) return;

    var parts = nameVal.split(' ');
    currentUser.firstName = parts[0];
    currentUser.lastName  = parts.slice(1).join(' ');
    currentUser.email     = document.getElementById('new-email').value.trim();
    currentUser.address   = selectedAddress;
    go('s-order');
  }

  /* ─── ORDER SCREEN ─── */
  function renderOrderScreen() {
    SERVICES.forEach(function(s) { s.qty = 0; });
    renderServices();
    var banner = document.getElementById('welcome-banner');
    if (currentUser && currentUser.firstName) {
      var greeting = isNewCustomer ? 'Welcome' : 'Welcome back';
      var fullName = [currentUser.firstName, currentUser.lastName].filter(Boolean).join(' ');
      banner.innerHTML =
        '<div class="welcome-banner">'
        + '<p>' + greeting + ',</p>'
        + '<strong>' + fullName + '! \uD83D\uDC4B</strong>'
        + '</div>';
    } else {
      banner.innerHTML = '';
    }
  }

  function renderServices() {
    document.getElementById('services-list').innerHTML = SERVICES.map(function(s, i) {
      var checked   = s.qty > 0;
      var checkIcon = checked
        ? '<svg width="12" height="10" viewBox="0 0 12 10" fill="none"><path d="M1 5L4.5 8.5L11 1" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
        : '';
      return (
        '<div class="service-row">'
        + '<div class="service-card ' + (checked ? 'has-items' : '') + '" id="card-' + s.id + '">'
        +   '<div class="service-check ' + (checked ? 'checked' : '') + '" id="check-' + s.id + '">' + checkIcon + '</div>'
        +   '<div class="service-info">'
        +     '<div class="service-name">' + s.name + '</div>'
        +     '<div class="service-price">' + s.price.toLocaleString() + '/item</div>'
        +   '</div>'
        + '</div>'
        + '<div class="qty-ctrl">'
        +   '<button class="qty-btn" onclick="changeQty(' + i + ',-1)">&#8722;</button>'
        +   '<input class="qty-input" id="qty-' + s.id + '" type="number" min="0" value="' + s.qty + '" oninput="setQty(' + i + ',this)">'
        +   '<button class="qty-btn" onclick="changeQty(' + i + ',1)">+</button>'
        + '</div>'
        + '</div>'
      );
    }).join('');
    updateSubtotal();
  }

  function updateCheck(id, active) {
    var card  = document.getElementById('card-' + id);
    var check = document.getElementById('check-' + id);
    card.classList.toggle('has-items', active);
    check.classList.toggle('checked', active);
    check.innerHTML = active
      ? '<svg width="12" height="10" viewBox="0 0 12 10" fill="none"><path d="M1 5L4.5 8.5L11 1" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      : '';
  }

  function changeQty(idx, delta) {
    SERVICES[idx].qty = Math.max(0, SERVICES[idx].qty + delta);
    var s = SERVICES[idx];
    document.getElementById('qty-' + s.id).value = s.qty;
    updateCheck(s.id, s.qty > 0);
    updateSubtotal();
  }

  function setQty(idx, input) {
    var val = Math.max(0, parseInt(input.value) || 0);
    SERVICES[idx].qty = val;
    input.value = val;
    updateCheck(SERVICES[idx].id, val > 0);
    updateSubtotal();
  }

  function updateSubtotal() {
    var sub = SERVICES.reduce(function(a, s) { return a + s.price * s.qty; }, 0);
    document.getElementById('order-subtotal').textContent = '\u20A6' + sub.toLocaleString();
    var hasItems = SERVICES.some(function(s) { return s.qty > 0; });
    document.getElementById('proceed-btn').disabled = !hasItems;
  }

  function proceedFromOrder() {
    if (!SERVICES.some(function(s) { return s.qty > 0; })) {
      alert('Please add at least one item to continue.');
      return;
    }
    go('s-summary');
  }

  /* ─── SUMMARY ─── */
  function renderSummary() {
    var items = SERVICES.filter(function(s) { return s.qty > 0; });
    var sub   = items.reduce(function(a, s) { return a + s.price * s.qty; }, 0);
    var total = sub + deliveryFee;

    orderId = genOrderId();
    document.getElementById('order-id-display').textContent = orderId;
    document.getElementById('pay-amount').textContent = '\u20A6' + total.toLocaleString();

    document.getElementById('summary-items').innerHTML =
      items.map(function(s) {
        return (
          '<div class="summary-row">'
          + '<span>' + s.name + ' <small style="color:var(--gray-500)">\xD7' + s.qty + '</small></span>'
          + '<span>\u20A6' + (s.price * s.qty).toLocaleString() + '</span>'
          + '</div>'
        );
      }).join('')
      + '<div class="summary-row sub-row">'
      +   '<span>Pickup &amp; Delivery <small style="color:var(--gray-500)">' + deliveryLabel + '</small></span>'
      +   '<span>\u20A6' + deliveryFee.toLocaleString() + '</span>'
      + '</div>'
      + '<div class="summary-row total">'
      +   '<span>Total Cost</span>'
      +   '<span>\u20A6' + total.toLocaleString() + '</span>'
      + '</div>';
  }

  /* ─── SUBMIT ORDER TO GOOGLE SHEET ─── */
  function submitOrder() {
    var btn = document.getElementById('confirm-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Submitting...'; }

    var items = SERVICES.filter(function(s) { return s.qty > 0; });
    var sub   = items.reduce(function(a, s) { return a + s.price * s.qty; }, 0);

    var payload = {
      vendorSlug:   CONFIG.VENDOR_SLUG,
      orderId:      orderId,
      customerName: currentUser ? (currentUser.firstName + ' ' + currentUser.lastName) : '',
      phone:        currentUser ? currentUser.phone : '',
      address:      selectedAddress || (currentUser ? currentUser.address : ''),
      items:        items.map(function(s) { return { name: s.name, qty: s.qty }; }),
      subtotal:     sub,
      deliveryFee:  deliveryFee,
    };

    fetch(CONFIG.ORDERS_API_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'text/plain' }, // avoids CORS preflight for Apps Script
      body:    JSON.stringify(payload),
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.success) {
        go('s-success');
      } else {
        alert('Something went wrong. Please try again.');
        if (btn) { btn.disabled = false; btn.textContent = 'Confirm Order'; }
      }
    })
    .catch(function() {
      // Still navigate to success — don't block the customer if network hiccups
      go('s-success');
    });
  }

  /* ─── RESET ─── */
  function resetApp() {
    currentUser      = null;
    isNewCustomer    = false;
    addressConfirmed = false;
    selectedAddress  = '';
    selectedCoords   = null;
    deliveryFee      = CONFIG.BASE_DELIVERY_FEE;
    deliveryLabel    = 'Calculating...';
    ['phone-input','new-name','new-email','new-addr','new-building','new-landmark']
      .forEach(function(id) { var el = document.getElementById(id); if (el) el.value = ''; });
    setAddrStatus('', '');
    hideDropdown();
    SERVICES.forEach(function(s) { s.qty = 0; });
    go('s-landing');
  }

  /* ─── BOOT ─── */
  document.addEventListener('DOMContentLoaded', function() {
    initMapboxAutocomplete();
  });

  document.getElementById('phone-input').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') checkPhone();
  });
