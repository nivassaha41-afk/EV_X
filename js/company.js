const COMPANY_DEMO = {
  username: 'owner@evcharge.com',
  password: 'evcharge123',
  dashboardTitle: 'GreenFlow Charging Hub'
};

const defaultState = {
  chargers: [
    {
      id: 'CH-01',
      location: 'Downtown Plaza',
      type: 'DC Fast',
      power: '60 kW',
      status: 'Active',
      slots: [
        { time: '08:00 - 08:30', aiStatus: 'Available', manualOverride: null, mode: 'AI', updatedAt: '11:45 AM', updatedBy: 'AI Engine' },
        { time: '08:30 - 09:00', aiStatus: 'Booked', manualOverride: null, mode: 'AI', updatedAt: '11:45 AM', updatedBy: 'AI Engine' },
        { time: '09:00 - 09:30', aiStatus: 'Available', manualOverride: null, mode: 'AI', updatedAt: '11:45 AM', updatedBy: 'AI Engine' },
        { time: '09:30 - 10:00', aiStatus: 'Maintenance', manualOverride: null, mode: 'AI', updatedAt: '11:45 AM', updatedBy: 'AI Engine' }
      ]
    },
    {
      id: 'CH-02',
      location: 'Mall South Entrance',
      type: 'Ultra Fast',
      power: '120 kW',
      status: 'Maintenance',
      slots: [
        { time: '08:00 - 08:30', aiStatus: 'Maintenance', manualOverride: null, mode: 'AI', updatedAt: '11:45 AM', updatedBy: 'AI Engine' },
        { time: '08:30 - 09:00', aiStatus: 'Available', manualOverride: null, mode: 'AI', updatedAt: '11:45 AM', updatedBy: 'AI Engine' },
        { time: '09:00 - 09:30', aiStatus: 'Booked', manualOverride: null, mode: 'AI', updatedAt: '11:45 AM', updatedBy: 'AI Engine' },
        { time: '09:30 - 10:00', aiStatus: 'Available', manualOverride: null, mode: 'AI', updatedAt: '11:45 AM', updatedBy: 'AI Engine' }
      ]
    },
    {
      id: 'CH-03',
      location: 'Airport Terminal',
      type: 'AC Type 2',
      power: '22 kW',
      status: 'Active',
      slots: [
        { time: '08:00 - 08:30', aiStatus: 'Available', manualOverride: null, mode: 'AI', updatedAt: '11:45 AM', updatedBy: 'AI Engine' },
        { time: '08:30 - 09:00', aiStatus: 'Available', manualOverride: null, mode: 'AI', updatedAt: '11:45 AM', updatedBy: 'AI Engine' },
        { time: '09:00 - 09:30', aiStatus: 'Booked', manualOverride: null, mode: 'AI', updatedAt: '11:45 AM', updatedBy: 'AI Engine' },
        { time: '09:30 - 10:00', aiStatus: 'Available', manualOverride: null, mode: 'AI', updatedAt: '11:45 AM', updatedBy: 'AI Engine' }
      ]
    }
  ]
};

function loadCompanyState() {
  try {
    const raw = localStorage.getItem('ev_company_dashboard_state');
    if (!raw) {
      localStorage.setItem('ev_company_dashboard_state', JSON.stringify(defaultState));
      return structuredClone(defaultState);
    }
    const parsed = JSON.parse(raw);
    return parsed && Array.isArray(parsed.chargers) ? parsed : structuredClone(defaultState);
  } catch (error) {
    return structuredClone(defaultState);
  }
}

function saveCompanyState(state) {
  localStorage.setItem('ev_company_dashboard_state', JSON.stringify(state));
}

function resolveSlotStatus(slot) {
  if (slot.manualOverride) return slot.manualOverride;
  return slot.aiStatus || 'Available';
}

function getStatusClass(status) {
  const key = (status || '').toLowerCase();
  if (key.includes('active') || status === 'Available') return 'active';
  if (key.includes('inactive') || status === 'Booked') return 'inactive';
  if (key.includes('maintenance') || status === 'Maintenance') return 'maintenance';
  return 'active';
}

function getBadgeClass(status) {
  const key = (status || '').toLowerCase();
  if (key.includes('available')) return 'available';
  if (key.includes('booked')) return 'booked';
  if (key.includes('maintenance')) return 'maintenance';
  if (key.includes('blocked')) return 'blocked';
  return 'available';
}

function formatTimeLabel() {
  return new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function getChargerSummary(charger, includeMode) {
  const statuses = charger.slots.map((slot) => resolveSlotStatus(slot));
  const availableCount = statuses.filter((status) => status === 'Available').length;
  const bookedCount = statuses.filter((status) => status === 'Booked').length;
  const maintenanceCount = statuses.filter((status) => status === 'Maintenance').length;

  return {
    availableCount,
    bookedCount,
    maintenanceCount,
    currentStatus: charger.status,
    mode: includeMode ? (charger.slots.some((slot) => slot.manualOverride) ? 'Manual' : 'AI') : null
  };
}

function initCompanyLogin() {
  const form = document.getElementById('companyLoginForm');
  const alertBox = document.getElementById('companyLoginAlert');

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const username = document.getElementById('companyUser').value.trim();
    const password = document.getElementById('companyPass').value.trim();

    if (username === COMPANY_DEMO.username && password === COMPANY_DEMO.password) {
      sessionStorage.setItem('ev_company_logged_in', 'true');
      sessionStorage.setItem('ev_company_owner_name', 'Company Owner');
      window.location.href = 'company-dashboard.html';
      return;
    }

    alertBox.classList.remove('hidden');
  });
}

function initCompanyDashboard() {
  const loggedIn = sessionStorage.getItem('ev_company_logged_in');
  if (loggedIn !== 'true') {
    window.location.href = 'company-login.html';
    return;
  }

  const state = loadCompanyState();
  const chargerList = document.getElementById('chargerList');
  const statsGrid = document.getElementById('statsGrid');
  const syncBtn = document.getElementById('syncAiBtn');
  const addChargerBtn = document.getElementById('addChargerBtn');
  const logoutBtn = document.getElementById('logoutBtn');
  const chargerForm = document.getElementById('chargerForm');

  function updateSummaryCards() {
    const totalChargers = state.chargers.length;
    const activeChargers = state.chargers.filter((c) => c.status === 'Active').length;
    const maintenanceChargers = state.chargers.filter((c) => c.status === 'Maintenance').length;
    const availableSlots = state.chargers.reduce((count, charger) => {
      return count + charger.slots.filter((slot) => resolveSlotStatus(slot) === 'Available').length;
    }, 0);

    const cards = [
      { label: 'Total Chargers', value: totalChargers, trend: 'Across all stations' },
      { label: 'Active', value: activeChargers, trend: '+2 from last check' },
      { label: 'Maintenance', value: maintenanceChargers, trend: 'Needs review' },
      { label: 'Available Slots', value: availableSlots, trend: 'Live availability' }
    ];

    statsGrid.innerHTML = cards.map((card) => `
      <div class="stat-card">
        <span class="label">${card.label}</span>
        <div class="value">${card.value}</div>
        <div class="trend">${card.trend}</div>
      </div>
    `).join('');

    const aiStatus = activeChargers > 0 ? 'Active' : 'Inactive';
    const usage = availableSlots > 10 ? 'Stable' : 'Moderate';
    document.getElementById('aiChargerStatus').textContent = aiStatus;
    document.getElementById('aiAvailableSlots').textContent = String(availableSlots);
    document.getElementById('aiUsageStatus').textContent = usage;
  }

  function renderChargerCards() {
    chargerList.innerHTML = state.chargers.map((charger) => {
      const combinedStatus = charger.status;
      const statusText = combinedStatus || 'Active';
      const summary = getChargerSummary(charger);
      const slotRows = charger.slots.map((slot) => {
        const currentStatus = resolveSlotStatus(slot);
        const modeText = slot.manualOverride ? 'Manual' : 'AI';
        return `
          <div class="slot-row">
            <div class="slot-time">${slot.time}</div>
            <span class="slot-badge ${getBadgeClass(currentStatus)}">${currentStatus}</span>
            <select data-slot-select="${charger.id}" data-slot-time="${slot.time}">
              <option value="Available" ${currentStatus === 'Available' ? 'selected' : ''}>Available</option>
              <option value="Booked" ${currentStatus === 'Booked' ? 'selected' : ''}>Booked</option>
              <option value="Maintenance" ${currentStatus === 'Maintenance' ? 'selected' : ''}>Maintenance</option>
              <option value="Blocked" ${currentStatus === 'Blocked' ? 'selected' : ''}>Blocked</option>
            </select>
            <button type="button" data-slot-update="${charger.id}" data-slot-time="${slot.time}">Update</button>
          </div>
        `;
      }).join('');

      return `
        <article class="charger-card">
          <div class="card-top">
            <div>
              <div class="charger-name">${charger.id}</div>
            </div>
            <span class="status-pill ${getStatusClass(statusText)}">${statusText}</span>
          </div>

          <div class="machine-meta">
            <span><i class="fa-solid fa-location-dot"></i> ${charger.location}</span>
            <span><i class="fa-solid fa-bolt"></i> ${charger.type}</span>
            <span><i class="fa-solid fa-gauge-high"></i> ${charger.power}</span>
          </div>

          <div class="status-detail">
            <div class="status-detail-grid">
              <div>
                Current Status
                <strong>${statusText}</strong>
              </div>
              <div>
                Update Mode
                <strong>${summary.mode || 'AI'}</strong>
              </div>
              <div>
                Available Slots
                <strong>${summary.availableCount}</strong>
              </div>
              <div>
                Last Updated
                <strong>${formatTimeLabel()}</strong>
              </div>
            </div>
          </div>

          <div class="slot-list" style="margin-top: 16px;">${slotRows}</div>
        </article>
      `;
    }).join('');
  }

  function renderDashboard() {
    updateSummaryCards();
    renderChargerCards();
  }

  function applyAiUpdate() {
    state.chargers = state.chargers.map((charger) => {
      const patterns = ['Available', 'Booked', 'Available', 'Maintenance'];
      charger.slots = charger.slots.map((slot, index) => {
        const nextStatus = patterns[index % patterns.length];
        if (slot.manualOverride) {
          return { ...slot, aiStatus: nextStatus, mode: 'Manual', updatedAt: formatTimeLabel(), updatedBy: 'Manual Override' };
        }
        return { ...slot, aiStatus: nextStatus, mode: 'AI', updatedAt: formatTimeLabel(), updatedBy: 'AI Engine' };
      });
      return { ...charger, status: charger.status === 'Maintenance' ? 'Maintenance' : 'Active' };
    });

    saveCompanyState(state);
    renderDashboard();
  }

  function updateManualSlot(chargerId, time, selectedValue) {
    state.chargers = state.chargers.map((charger) => {
      if (charger.id !== chargerId) return charger;
      charger.slots = charger.slots.map((slot) => {
        if (slot.time !== time) return slot;
        const nextSlot = { ...slot, manualOverride: selectedValue, mode: 'Manual', updatedAt: formatTimeLabel(), updatedBy: 'Company Owner' };
        return nextSlot;
      });
      return charger;
    });

    saveCompanyState(state);
    renderDashboard();
  }

  function handleAddCharger(event) {
    event.preventDefault();
    const id = document.getElementById('chargerId').value.trim();
    const location = document.getElementById('chargerLocation').value.trim();
    const type = document.getElementById('chargerType').value;
    const power = document.getElementById('chargerPower').value.trim();
    const status = document.getElementById('chargerStatus').value;

    if (!id || !location || !power) return;

    const existing = state.chargers.some((charger) => charger.id.toLowerCase() === id.toLowerCase());
    if (existing) {
      state.chargers = state.chargers.map((charger) => charger.id.toLowerCase() === id.toLowerCase() ? {
        ...charger,
        location,
        type,
        power,
        status
      } : charger);
    } else {
      const generatedSlots = ['08:00 - 08:30', '08:30 - 09:00', '09:00 - 09:30', '09:30 - 10:00'].map((time) => ({
        time,
        aiStatus: 'Available',
        manualOverride: null,
        mode: 'AI',
        updatedAt: formatTimeLabel(),
        updatedBy: 'AI Engine'
      }));

      state.chargers.push({ id, location, type, power, status, slots: generatedSlots });
    }

    saveCompanyState(state);
    renderDashboard();
    chargerForm.reset();
  }

  syncBtn.addEventListener('click', applyAiUpdate);
  addChargerBtn.addEventListener('click', () => {
    document.getElementById('chargerId').focus();
  });
  chargerForm.addEventListener('submit', handleAddCharger);

  logoutBtn.addEventListener('click', () => {
    sessionStorage.removeItem('ev_company_logged_in');
    sessionStorage.removeItem('ev_company_owner_name');
    window.location.href = 'company-login.html';
  });

  document.addEventListener('click', (event) => {
    const updateButton = event.target.closest('[data-slot-update]');
    if (!updateButton) return;

    const chargerId = updateButton.dataset.slotUpdate;
    const slotTime = updateButton.dataset.slotTime;
    const select = document.querySelector(`select[data-slot-select="${chargerId}"][data-slot-time="${slotTime}"]`);
    if (!select) return;

    updateManualSlot(chargerId, slotTime, select.value);
  });

  document.addEventListener('change', (event) => {
    const target = event.target.closest('[data-slot-select]');
    if (!target) return;

    const chargerId = target.dataset.slotSelect;
    const slotTime = target.dataset.slotTime;
    updateManualSlot(chargerId, slotTime, target.value);
  });

  renderDashboard();
}

const pageType = document.body.dataset.page;
if (pageType === 'login') {
  initCompanyLogin();
}

if (pageType === 'dashboard') {
  initCompanyDashboard();
}
