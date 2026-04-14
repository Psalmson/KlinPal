/* ════════════════════════════════════════════════════════════════
   CONFIGURATION
════════════════════════════════════════════════════════════════ */
var CONFIG = {
  // Google Maps API key — address autocomplete + distance calculation
  GOOGLE_MAPS_KEY: 'AIzaSyA4mpTBCqmyZpCZFtP-_oVvjs_8AhNoSa0',

  // Supabase
  SUPABASE_URL:  'https://mlgdqxqzpzfzndjhywqf.supabase.co',
  SUPABASE_KEY:  'sb_publishable_TS5uGf7KzLKxeQw8bxDKYw_HwBNNBeA',

  // Pricing defaults — overridden by vendor config
  BASE_DELIVERY_FEE: 1500,
  RATE_PER_KM:       200,

  // Autocomplete settings
  DEBOUNCE_MS: 350,
  MIN_CHARS:   3,
};

/* ─── SUPABASE HELPER ─── */
function sbFetch(path, options) {
  var url      = CONFIG.SUPABASE_URL + '/rest/v1/' + path;
  var headers  = Object.assign({
    'apikey':        CONFIG.SUPABASE_KEY,
    'Authorization': 'Bearer ' + CONFIG.SUPABASE_KEY,
    'Content-Type':  'application/json',
    'Prefer':        'return=representation',
  }, (options && options.headers) || {});
  var opts = Object.assign({}, options || {}, { headers: headers });
  return fetch(url, opts);
}

/* ─── VENDOR STATE (populated dynamically from URL slug) ─── */
var VENDOR = {
  id:               '',
  slug:             '',
  name:             '',
  lat:              6.5244,
  lng:              3.3792,
  telegram_chat_id: null,
  platform_fee_pct: null, // null = use global rate
};

var GLOBAL_PLATFORM_FEE_PCT = 10; // fallback, overwritten on bootstrap

/* ─── APP STATE ─── */
var SERVICES = [
{ id: 'express', name: 'Express Wash', price: 300, qty: 0 },
{ id: 'fold',    name: 'Wash + Fold',  price: 300, qty: 0 },
{ id: 'iron',    name: 'Wash + Iron',  price: 300, qty: 0 },
{ id: 'dry',     name: 'Dry-clean',    price: 300, qty: 0 },
];

var currentUser      = null;
var isNewCustomer    = false;
var orderId          = '';
var deliveryFee      = CONFIG.BASE_DELIVERY_FEE;
var serviceFee       = 0;
var platformFee      = 0;
var deliveryLabel    = 'Calculating...';
var selectedAddress  = '';
var selectedCoords   = null;
var addressConfirmed = false;
var debounceTimer    = null;

function genOrderId() {
  return 'ORD-' + Date.now().toString(36).toUpperCase();
}

/* ════════════════════════════════════════════════════════════════
   GOOGLE MAPS ADDRESS AUTOCOMPLETE
   Uses Google Places API (New) — Lagos-biased, Nigeria only.
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
  var url = 'https://places.googleapis.com/v1/places:autocomplete';
  fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type':     'application/json',
      'X-Goog-Api-Key':   CONFIG.GOOGLE_MAPS_KEY,
    },
    body: JSON.stringify({
      input:               query,
      includedRegionCodes: ['ng'],
      locationBias: {
        circle: {
          center: { latitude: VENDOR.lat, longitude: VENDOR.lng },
          radius: 50000
        }
      }
    })
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    var suggestions = (data.suggestions || []).filter(function(s) { return s.placePrediction; });
    renderDropdown(suggestions);
  })
  .catch(function() { hideDropdown(); });
}

function renderDropdown(results) {
  var dropdown = document.getElementById('addr-dropdown');
  if (!results.length) { hideDropdown(); return; }

  dropdown.innerHTML = results.map(function(r, i) {
    var pred = r.placePrediction;
    var main = pred.structuredFormat && pred.structuredFormat.mainText
      ? pred.structuredFormat.mainText.text
      : pred.text.text;
    var secondary = pred.structuredFormat && pred.structuredFormat.secondaryText
      ? pred.structuredFormat.secondaryText.text : '';
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
  var pred    = result.placePrediction;
  var placeId = pred.placeId;
  var full    = pred.text.text;

  document.getElementById('new-addr').value = full;
  hideDropdown();
  setAddrStatus('Calculating...', 'loading');

  // Geocode placeId to get lat/lng
  fetch('https://places.googleapis.com/v1/places/' + placeId + '?fields=location', {
    headers: {
      'X-Goog-Api-Key':    CONFIG.GOOGLE_MAPS_KEY,
      'X-Goog-FieldMask':  'location'
    }
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    var lat = data.location.latitude;
    var lng = data.location.longitude;
    selectedAddress  = full;
    selectedCoords   = { lat: lat, lng: lng };
    addressConfirmed = true;
    calculateDeliveryFee(selectedCoords);
  })
  .catch(function() {
    setAddrStatus('Could not get location', 'err');
  });
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
   Uses Google Directions API — road distance from vendor → customer address.
════════════════════════════════════════════════════════════════ */
function calculateDeliveryFee(coords) {
  setAddrStatus('Calculating...', 'loading');
  calculateDeliveryFeeWithCallback(coords, function(km, err) {
    if (err) {
      setAddrStatus('Could not calculate distance', 'err');
    } else {
      setAddrStatus('\u2713 ' + km + ' km away', 'ok');
    }
  });
}

function calculateDeliveryFeeWithCallback(coords, callback) {
  var origin      = VENDOR.lat + ',' + VENDOR.lng;
  var destination = coords.lat + ',' + coords.lng;

  fetch(CONFIG.SUPABASE_URL + '/functions/v1/google-directions', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'apikey':        CONFIG.SUPABASE_KEY,
      'Authorization': 'Bearer ' + CONFIG.SUPABASE_KEY,
    },
    body: JSON.stringify({ origin: origin, destination: destination })
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.error) throw new Error(data.error);
    var km          = data.km;
    var roundTripKm = km * 2;
    deliveryFee     = Math.round(CONFIG.BASE_DELIVERY_FEE + CONFIG.RATE_PER_KM * roundTripKm);
    serviceFee      = Math.min(Math.round(deliveryFee * 0.2), 1000);
    deliveryLabel   = km + ' km';
    if (callback) callback(km, null);
  })
  .catch(function() {
    deliveryFee   = CONFIG.BASE_DELIVERY_FEE;
    deliveryLabel = 'Could not calculate';
    if (callback) callback(null, true);
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
  if (screenId === 's-confirm') renderConfirmScreen();
}

function goBackFromOrder() {
  // New customers go back to personal details; returning customers go to confirm address
  go(isNewCustomer ? 's-new' : 's-confirm');
}

/* ─── STEP 2b: CONFIRM ADDRESS (returning customers) ─── */
var confirmDebounceTimer = null;
var confirmAddressConfirmed = false;
var confirmSelectedAddress  = '';
var confirmSelectedCoords   = null;

function renderConfirmScreen() {
  confirmAddressConfirmed = false;
  confirmSelectedAddress  = '';
  confirmSelectedCoords   = null;
  document.getElementById('address-change-panel').style.display = 'none';
  document.getElementById('confirm-new-addr').value = '';
  document.getElementById('confirm-addr-status').textContent = '';
  document.getElementById('confirm-addr-error').style.display = 'none';

  var fullName = [currentUser.firstName, currentUser.lastName].filter(Boolean).join(' ');
  document.getElementById('confirm-greeting').textContent = 'Welcome back, ' + fullName + '! 👋';
  document.getElementById('confirm-address-text').textContent = currentUser.address || 'No address saved';

  // Pre-calculate delivery fee for saved address
  if (currentUser.address && !addressConfirmed) {
    geocodeAddress(currentUser.address, function(coords) {
      if (coords) {
        selectedAddress  = currentUser.address;
        selectedCoords   = coords;
        addressConfirmed = true;
        calculateDeliveryFee(coords);
      }
    });
  }

  // Init autocomplete for change address panel
  initConfirmAutocomplete();
}

function geocodeAddress(address, callback) {
  var url = 'https://maps.googleapis.com/maps/api/geocode/json'
    + '?address=' + encodeURIComponent(address)
    + '&region=ng'
    + '&key=' + CONFIG.GOOGLE_MAPS_KEY;
  fetch(url)
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.results && data.results.length) {
        var loc = data.results[0].geometry.location;
        callback({ lat: loc.lat, lng: loc.lng });
      } else { callback(null); }
    })
    .catch(function() { callback(null); });
}

function confirmAddress() {
  // Use existing saved address — already geocoded in renderConfirmScreen
  go('s-order');
}

function showAddressChange() {
  document.getElementById('address-change-panel').style.display = 'block';
}

function initConfirmAutocomplete() {
  var input    = document.getElementById('confirm-new-addr');
  var dropdown = document.getElementById('confirm-addr-dropdown');
  if (!input || !dropdown) return;

  input.addEventListener('input', function() {
    confirmAddressConfirmed = false;
    confirmSelectedAddress  = '';
    confirmSelectedCoords   = null;
    document.getElementById('confirm-addr-status').textContent = '';
    clearTimeout(confirmDebounceTimer);
    var q = input.value.trim();
    if (q.length < CONFIG.MIN_CHARS) { dropdown.style.display = 'none'; return; }
    confirmDebounceTimer = setTimeout(function() { fetchConfirmSuggestions(q); }, CONFIG.DEBOUNCE_MS);
  });

  document.addEventListener('click', function(e) {
    if (!input.contains(e.target) && !dropdown.contains(e.target)) dropdown.style.display = 'none';
  });
}

function fetchConfirmSuggestions(query) {
  fetch('https://places.googleapis.com/v1/places:autocomplete', {
    method: 'POST',
    headers: {
      'Content-Type':   'application/json',
      'X-Goog-Api-Key': CONFIG.GOOGLE_MAPS_KEY,
    },
    body: JSON.stringify({
      input:               query,
      includedRegionCodes: ['ng'],
      locationBias: {
        circle: {
          center: { latitude: VENDOR.lat, longitude: VENDOR.lng },
          radius: 50000
        }
      }
    })
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    var suggestions = (data.suggestions || []).filter(function(s) { return s.placePrediction; });
    renderConfirmDropdown(suggestions);
  })
  .catch(function() { document.getElementById('confirm-addr-dropdown').style.display = 'none'; });
}

function renderConfirmDropdown(results) {
  var dropdown = document.getElementById('confirm-addr-dropdown');
  if (!results.length) { dropdown.style.display = 'none'; return; }
  dropdown.innerHTML = results.map(function(r, i) {
    var pred = r.placePrediction;
    var main = pred.structuredFormat && pred.structuredFormat.mainText
      ? pred.structuredFormat.mainText.text : pred.text.text;
    var sub = pred.structuredFormat && pred.structuredFormat.secondaryText
      ? pred.structuredFormat.secondaryText.text : '';
    return '<div class="addr-item" data-idx="' + i + '">'
      + '<span class="addr-item-main">' + escHtml(main) + '</span>'
      + (sub ? '<span class="addr-item-sub">' + escHtml(sub) + '</span>' : '')
      + '</div>';
  }).join('');
  dropdown.querySelectorAll('.addr-item').forEach(function(el, i) {
    el.addEventListener('click', function() { selectConfirmSuggestion(results[i]); });
  });
  dropdown.style.display = 'block';
}

function selectConfirmSuggestion(result) {
  var pred    = result.placePrediction;
  var placeId = pred.placeId;
  var full    = pred.text.text;

  document.getElementById('confirm-new-addr').value = full;
  document.getElementById('confirm-addr-dropdown').style.display = 'none';
  document.getElementById('confirm-addr-status').textContent = 'Calculating distance...';
  document.getElementById('confirm-addr-status').className = 'addr-status loading';

  fetch('https://places.googleapis.com/v1/places/' + placeId + '?fields=location', {
    headers: {
      'X-Goog-Api-Key':   CONFIG.GOOGLE_MAPS_KEY,
      'X-Goog-FieldMask': 'location'
    }
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    var lat = data.location.latitude;
    var lng = data.location.longitude;
    confirmSelectedAddress  = full;
    confirmSelectedCoords   = { lat: lat, lng: lng };
    confirmAddressConfirmed = true;
    calculateDeliveryFeeWithCallback({ lat: lat, lng: lng }, function(km, err) {
      var statusEl = document.getElementById('confirm-addr-status');
      if (err) {
        statusEl.textContent = 'Could not calculate distance';
        statusEl.className = 'addr-status err';
      } else {
        statusEl.textContent = '\u2713 ' + km + ' km away';
        statusEl.className = 'addr-status ok';
      }
    });
  })
  .catch(function() {
    document.getElementById('confirm-addr-status').textContent = 'Could not get location';
    document.getElementById('confirm-addr-status').className = 'addr-status err';
  });
}

function submitAddressChange() {
  var errEl = document.getElementById('confirm-addr-error');
  if (!confirmAddressConfirmed || !confirmSelectedAddress) {
    errEl.style.display = 'block';
    return;
  }
  errEl.style.display = 'none';

  // Update selected address
  selectedAddress  = confirmSelectedAddress;
  selectedCoords   = confirmSelectedCoords;
  addressConfirmed = true;

  // Update display card
  document.getElementById('confirm-address-text').textContent = confirmSelectedAddress;
  document.getElementById('address-change-panel').style.display = 'none';

  // Save new address to customer record
  if (currentUser && currentUser.customerId) {
    sbFetch('customers?id=eq.' + currentUser.customerId, {
      method: 'PATCH',
      body: JSON.stringify({ address: confirmSelectedAddress })
    }).catch(function() {});
  }

  currentUser.address = confirmSelectedAddress;
  go('s-order');
}

/* ─── STEP 1: CHECK PHONE ─── */
function checkPhone() {
  var input = document.getElementById('phone-input');
  var err   = document.getElementById('phone-error');
  var phone = input.value.trim().replace(/\s+/g, '');

  // Normalise +234 format to 11-digit local format
  if (phone.startsWith('+234')) phone = '0' + phone.slice(4);
  else if (phone.startsWith('234') && phone.length === 13) phone = '0' + phone.slice(3);

  if (phone.length !== 11 || !/^\d{11}$/.test(phone)) {
    input.classList.add('input-error');
    err.textContent = 'Please enter a valid 11-digit Nigerian phone number';
    err.style.display = 'block';
    return;
  }
  input.value = phone; // update field with normalised number
  input.classList.remove('input-error');
  err.style.display = 'none';
  go('s-checking');

  sbFetch('customers?vendor_id=eq.' + VENDOR.id + '&phone=eq.' + encodeURIComponent(phone) + '&limit=1')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data && data.length) {
        var c = data[0];
        currentUser   = { phone: c.phone, firstName: c.first_name, lastName: c.last_name, email: c.email, address: c.address, customerId: c.id };
        isNewCustomer = false;
        go('s-confirm');
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
    })
    .catch(function() {
      currentUser      = { phone: phone, firstName: '', lastName: '', email: '', address: '' };
      isNewCustomer    = true;
      addressConfirmed = false;
      selectedAddress  = '';
      selectedCoords   = null;
      deliveryFee      = CONFIG.BASE_DELIVERY_FEE;
      deliveryLabel    = 'Calculating...';
      go('s-new');
    });
}

/* ─── STEP 2a: NEW CUSTOMER SUBMIT ─── */
function submitNewCustomer() {
  var nameInput    = document.getElementById('new-name');
  var addrInput    = document.getElementById('new-addr');
  var nameVal      = nameInput.value.trim();
  var valid        = true;

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
    addrErr.textContent   = 'Please select a street from the suggestions';
    addrErr.style.display = 'block';
    valid = false;
  } else {
    addrInput.classList.remove('input-error');
    document.getElementById('new-addr-error').style.display = 'none';
  }

  if (!valid) return;

  var landmark    = document.getElementById('new-landmark').value.trim();
  var fullAddress = selectedAddress + (landmark ? ' (' + landmark + ')' : '');

  var parts = nameVal.split(' ');
  currentUser.firstName = parts[0];
  currentUser.lastName  = parts.slice(1).join(' ');
  currentUser.email     = document.getElementById('new-email').value.trim();
  currentUser.address   = fullAddress;
  selectedAddress       = fullAddress;

  // Upsert customer to Supabase
  sbFetch('customers', {
    method: 'POST',
    headers: { 'Prefer': 'resolution=merge-duplicates' },
    body: JSON.stringify({
      vendor_id:  VENDOR.id,
      phone:      currentUser.phone,
      first_name: currentUser.firstName,
      last_name:  currentUser.lastName,
      email:      currentUser.email || '',
      address:    fullAddress,
    }),
  }).catch(function() {}); // fire and forget

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

  // For returning customers, geocode their saved address to get delivery fee
  if (!isNewCustomer && currentUser && currentUser.address && !addressConfirmed) {
    selectedAddress  = currentUser.address;
    addressConfirmed = true;
    deliveryFee      = CONFIG.BASE_DELIVERY_FEE;
    deliveryLabel    = 'Calculating...';

    // Geocode the saved address to get coords for distance calculation
    var geocodeUrl = 'https://maps.googleapis.com/maps/api/geocode/json'
      + '?address=' + encodeURIComponent(currentUser.address)
      + '&region=ng'
      + '&key=' + CONFIG.GOOGLE_MAPS_KEY;

    fetch(geocodeUrl)
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.results && data.results.length) {
          var loc    = data.results[0].geometry.location;
          var coords = { lat: loc.lat, lng: loc.lng };
          selectedCoords = coords;
          calculateDeliveryFee(coords);
        } else {
          deliveryFee   = CONFIG.BASE_DELIVERY_FEE;
          deliveryLabel = 'Flat rate';
        }
      })
      .catch(function() {
        deliveryFee   = CONFIG.BASE_DELIVERY_FEE;
        deliveryLabel = 'Flat rate';
      });
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
  var effectivePct = VENDOR.platform_fee_pct != null ? VENDOR.platform_fee_pct : GLOBAL_PLATFORM_FEE_PCT;
  platformFee = Math.round(sub * effectivePct / 100);
  var total = sub + deliveryFee + serviceFee; // base delivery + service fee + subtotal

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
    + '<div class="summary-row sub-row">'
    +   '<span>Service Fee</span>'
    +   '<span>\u20A6' + serviceFee.toLocaleString() + '</span>'
    + '</div>'
    + '<div class="summary-row total">'
    +   '<span>Total Cost</span>'
    +   '<span>\u20A6' + total.toLocaleString() + '</span>'
    + '</div>';
}

/* ─── SUBMIT ORDER TO SUPABASE ─── */
function submitOrder() {
  var btn = document.getElementById('confirm-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Submitting...'; }

  var items = SERVICES.filter(function(s) { return s.qty > 0; });
  var sub   = items.reduce(function(a, s) { return a + s.price * s.qty; }, 0);
  var total = sub + deliveryFee + serviceFee;

  var itemsStr = items.map(function(s) { return s.qty + 'x ' + s.name; }).join(', ');

  var orderPayload = {
    order_id:      orderId,
    vendor_id:     VENDOR.id,
    customer_name: currentUser ? (currentUser.firstName + ' ' + currentUser.lastName) : '',
    phone:         currentUser ? currentUser.phone : '',
    address:       selectedAddress || (currentUser ? currentUser.address : ''),
    items:         itemsStr,
    subtotal:      sub,
    delivery_fee:  deliveryFee,
    service_fee:   serviceFee,
    platform_fee:  platformFee,
    total:         total,
    status:        'Pending',
  };

  sbFetch('orders', {
    method: 'POST',
    body: JSON.stringify(orderPayload),
  })
  .then(function(r) {
    if (r.ok) {
      // Fire Telegram notification — fire and forget
      fetch(CONFIG.SUPABASE_URL + '/functions/v1/notify-order', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          order:          orderPayload,
          vendor_name:    VENDOR.name,
          vendor_chat_id: VENDOR.telegram_chat_id || null,
        }),
      })
      .then(function(r) { return r.json(); })
      .then(function(d) { console.log('Notify result:', d); })
      .catch(function(e) { console.error('Notify error:', e); });

      // Open WhatsApp with pre-filled payment proof message
      var customerAddress = selectedAddress || (currentUser ? currentUser.address : '');
      var waMsg = encodeURIComponent(
        'Hi ' + VENDOR.name + ' \uD83D\uDC4B\n\n'
        + 'I just placed an order and have made payment.\n\n'
        + 'Order ID: ' + orderId + '\n'
        + 'Amount Paid: \u20A6' + total.toLocaleString() + '\n'
        + 'Pickup & Delivery Address: ' + customerAddress + '\n\n'
        + 'Please find my payment receipt attached.'
      );
      window.open('https://wa.me/2349031186357?text=' + waMsg, '_blank');

      go('s-success');
    } else {
      alert('Something went wrong. Please try again.');
      if (btn) { btn.disabled = false; btn.textContent = 'Confirm Order'; }
    }
  })
  .catch(function() {
    go('s-success');
  });
}

/* ─── RESET ─── */
function resetApp() {
  currentUser             = null;
  isNewCustomer           = false;
  addressConfirmed        = false;
  selectedAddress         = '';
  selectedCoords          = null;
  deliveryFee             = CONFIG.BASE_DELIVERY_FEE;
  serviceFee              = 0;
  platformFee             = 0;
  deliveryLabel           = 'Calculating...';
  confirmAddressConfirmed = false;
  confirmSelectedAddress  = '';
  confirmSelectedCoords   = null;
  ['phone-input','new-name','new-email','new-addr','new-landmark','confirm-new-addr']
    .forEach(function(id) { var el = document.getElementById(id); if (el) el.value = ''; });
  var panel = document.getElementById('address-change-panel');
  if (panel) panel.style.display = 'none';
  var confirmStatus = document.getElementById('confirm-addr-status');
  if (confirmStatus) confirmStatus.textContent = '';
  setAddrStatus('', '');
  hideDropdown();
  SERVICES.forEach(function(s) { s.qty = 0; });
  go('s-landing');
}

/* ─── BOOT ─── */
document.addEventListener('DOMContentLoaded', function() {
  initMapboxAutocomplete();
  bootstrapVendor();
});

document.getElementById('phone-input').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') checkPhone();
});

/* ════════════════════════════════════════════════════════════════
   VENDOR BOOTSTRAP
   Reads ?vendor=slug from the URL, fetches vendor from Supabase,
   then unlocks the app.
════════════════════════════════════════════════════════════════ */
function bootstrapVendor() {
  var params = new URLSearchParams(window.location.search);
  var slug   = params.get('vendor');

  if (!slug) {
    showVendorError('No vendor specified. Please use a valid Klinpal link.');
    return;
  }

  // Fetch vendor and global platform fee in parallel
  Promise.all([
    sbFetch('vendors?slug=eq.' + encodeURIComponent(slug) + '&limit=1&select=*').then(function(r){ return r.json(); }),
    sbFetch('platform_settings?key=eq.platform_fee_pct&limit=1&select=value').then(function(r){ return r.json(); })
  ])
  .then(function(results) {
    var data     = results[0];
    var settings = results[1];

    if (!data || !data.length) {
      showVendorError('Vendor not found. Please check your link.');
      return;
    }
    var vendor = data[0];

    // Set global rate (fallback 10)
    if (Array.isArray(settings) && settings.length) {
      GLOBAL_PLATFORM_FEE_PCT = parseFloat(settings[0].value) || 10;
    }

    VENDOR.id               = vendor.id;
    VENDOR.slug             = vendor.slug;
    VENDOR.name             = vendor.name;
    VENDOR.lat              = vendor.lat  || 6.5244;
    VENDOR.lng              = vendor.lng  || 3.3792;
    VENDOR.telegram_chat_id = vendor.telegram_chat_id || null;
    VENDOR.brand_color      = vendor.brand_color || null;
    VENDOR.logo_url         = vendor.logo_url     || null;
    VENDOR.platform_fee_pct = vendor.platform_fee_pct != null ? parseFloat(vendor.platform_fee_pct) : null;

    // Apply brand colour
    if (VENDOR.brand_color) {
      document.documentElement.style.setProperty('--teal', VENDOR.brand_color);
      document.documentElement.style.setProperty('--teal-dark', VENDOR.brand_color);
    }

    // Apply vendor logo
    if (VENDOR.logo_url) {
      document.querySelectorAll('.logo-img').forEach(function(img) {
        img.src = VENDOR.logo_url;
        img.alt = VENDOR.name;
      });
    }

    document.title = VENDOR.name + ' — Laundry';
    var brandEls = document.querySelectorAll('.vendor-name-placeholder');
    brandEls.forEach(function(el) { el.textContent = VENDOR.name; });

    // Load active services
    if (vendor.services && vendor.services.length) {
      SERVICES = vendor.services
        .filter(function(s) { return s.active; })
        .map(function(s) { return { id: s.id, name: s.name, price: s.price, qty: 0 }; });
    }
    go('s-landing');
  })
  .catch(function() {
    showVendorError('Could not load vendor. Please try again.');
  });
}

function showVendorError(msg) {
  document.body.innerHTML =
    '<div style="display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:sans-serif;color:#8a9ab5;background:#0d1b2a;flex-direction:column;gap:12px;">'
    + '<div style="font-size:32px">⚠️</div>'
    + '<div style="font-size:15px">' + msg + '</div>'
    + '</div>';
}
