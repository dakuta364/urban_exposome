const BACKEND_BASE_URL =
    window.BACKEND_BASE_URL ||
    ((window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
        ? window.location.protocol + '//' + window.location.hostname + ':8000'
        : 'https://urban-exposome.onrender.com');
const BACKEND_WARMUP_TEXT = 'Сервер анализа запускается, это может занять до 60 секунд';

const map = L.map('map', { zoomControl: false }).setView([45.2, 34.3], 8);
map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');

L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; CARTO (надписи: OSM)'
}).addTo(map);

map.createPane('labels');
map.getPane('labels').style.zIndex = 650;
map.getPane('labels').style.pointerEvents = 'none';
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png', {
    pane: 'labels'
}).addTo(map);

const imageBounds = [[44.37708309, 32.48125074], [46.23124977, 36.63958411]];

const overlays = {
    light: L.imageOverlay('overlays/light.png', imageBounds, { opacity: 0.75 }),
    heat: L.imageOverlay('overlays/heat.png', imageBounds, { opacity: 0.75 }),
    no2: L.imageOverlay('overlays/no2.png', imageBounds, { opacity: 0.75 }),
    noise: L.imageOverlay('overlays/noise.png', imageBounds, { opacity: 0.75 })
};

const backendStatusEl = document.getElementById('backend-status');
const sidebar = document.getElementById('sidebar');
const closeBtn = document.getElementById('close-btn');

const btnSingleAdvanced = document.getElementById('btn-single-advanced');
const aiAdvancedLoadingEl = document.getElementById('ai-advanced-loading');
const aiAdvancedTextEl = document.getElementById('ai-advanced-text');

const btnComplex = document.getElementById('btn-complex');
const complexBlock = document.getElementById('complex-result-block');
const complexTextEl = document.getElementById('complex-text');
const complexLoadingEl = document.getElementById('complex-loading');
const complexAdvancedWrap = document.getElementById('complex-advanced-wrap');
const btnComplexAdvanced = document.getElementById('btn-complex-advanced');
const complexAdvancedLoadingEl = document.getElementById('complex-advanced-loading');
const complexAdvancedTextEl = document.getElementById('complex-advanced-text');

let currentLayerId = 'light';
let currentMarker = null;
let currentCoords = null;
let backendReady = false;
let llmAvailable = false;
let healthCheckInFlight = null;

overlays[currentLayerId].addTo(map);

const sciIcon = L.divIcon({
    className: 'sci-marker',
    html: '<div class="sci-pulse"></div><div class="sci-dot"></div>',
    iconSize: [20, 20],
    iconAnchor: [10, 10]
});

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function setBackendStatus(text, type = 'info', sticky = true) {
    backendStatusEl.innerText = text;
    backendStatusEl.classList.remove('hidden', 'status-info', 'status-warning', 'status-error');
    backendStatusEl.classList.add(`status-${type}`);
    backendStatusEl.dataset.sticky = sticky ? '1' : '0';
}

function hideBackendStatus() {
    if (backendStatusEl.dataset.sticky === '1') return;
    backendStatusEl.classList.add('hidden');
}

async function fetchWithTimeout(url, timeoutMs = 7000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(url, { signal: controller.signal });
        return response;
    } finally {
        clearTimeout(timeout);
    }
}

async function checkBackendHealth({ timeoutMs = 7000, silent = false } = {}) {
    if (healthCheckInFlight) {
        return healthCheckInFlight;
    }

    healthCheckInFlight = (async () => {
        try {
            const response = await fetchWithTimeout(`${BACKEND_BASE_URL}/healthz`, timeoutMs);
            if (!response.ok) {
                backendReady = false;
                if (!silent) {
                    setBackendStatus(BACKEND_WARMUP_TEXT, 'warning', true);
                }
                return false;
            }

            const status = await response.json();
            backendReady = Boolean(status.ok);
            llmAvailable = Boolean(status.llm_available);

            if (backendReady) {
                if (!silent) {
                    setBackendStatus('Сервер анализа готов.', 'info', false);
                    setTimeout(hideBackendStatus, 1800);
                }
                return true;
            }

            if (!silent) {
                setBackendStatus(BACKEND_WARMUP_TEXT, 'warning', true);
            }
            return false;
        } catch (_) {
            backendReady = false;
            if (!silent) {
                setBackendStatus(BACKEND_WARMUP_TEXT, 'warning', true);
            }
            return false;
        } finally {
            healthCheckInFlight = null;
        }
    })();

    return healthCheckInFlight;
}

async function ensureBackendReady(maxWaitMs = 65000) {
    if (backendReady) {
        return true;
    }

    setBackendStatus(BACKEND_WARMUP_TEXT, 'warning', true);

    const startedAt = Date.now();
    while (Date.now() - startedAt < maxWaitMs) {
        const ok = await checkBackendHealth({ timeoutMs: 7000, silent: true });
        if (ok) {
            setBackendStatus('Сервер анализа готов.', 'info', false);
            setTimeout(hideBackendStatus, 1800);
            return true;
        }
        await sleep(4000);
    }

    setBackendStatus('Сервер анализа пока недоступен. Проверьте подключение и повторите попытку.', 'error', true);
    return false;
}

async function apiGet(path, params = {}) {
    const url = new URL(`${BACKEND_BASE_URL}${path}`);
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));

    const response = await fetch(url.toString());
    const data = await response.json();

    if (!response.ok) {
        const message = data.error || `HTTP ${response.status}`;
        throw new Error(message);
    }

    return data;
}

function openSidebar() {
    sidebar.classList.remove('hidden');
    if (window.innerWidth <= 768) {
        sidebar.classList.add('half-open');
        sidebar.classList.remove('full-open');
    } else {
        setTimeout(() => map.invalidateSize(), 300);
    }
}

function closeSidebar() {
    sidebar.classList.add('hidden');
    sidebar.classList.remove('half-open', 'full-open');
    if (currentMarker) {
        map.removeLayer(currentMarker);
        currentMarker = null;
    }
    setTimeout(() => map.invalidateSize(), 300);
}

function resetSingleAdvancedUI() {
    btnSingleAdvanced.classList.add('hidden');
    aiAdvancedLoadingEl.classList.add('hidden');
    aiAdvancedTextEl.classList.add('hidden');
    aiAdvancedTextEl.innerText = '';
}

function resetComplexAdvancedUI() {
    complexAdvancedWrap.classList.add('hidden');
    complexAdvancedLoadingEl.classList.add('hidden');
    complexAdvancedTextEl.classList.add('hidden');
    complexAdvancedTextEl.innerText = '';
}

closeBtn.addEventListener('click', closeSidebar);

let startY = 0;
sidebar.addEventListener('touchstart', e => { startY = e.touches[0].clientY; });
sidebar.addEventListener('touchend', e => {
    if (window.innerWidth > 768) return;
    const endY = e.changedTouches[0].clientY;

    if (startY - endY > 50) {
        sidebar.classList.replace('half-open', 'full-open');
    } else if (endY - startY > 50) {
        if (sidebar.classList.contains('full-open')) {
            sidebar.classList.replace('full-open', 'half-open');
        } else {
            closeSidebar();
        }
    }
});

map.on('click', function (e) {
    const lat = e.latlng.lat;
    const lon = e.latlng.lng;
    currentCoords = { lat, lon };

    if (currentMarker) map.removeLayer(currentMarker);
    currentMarker = L.marker([lat, lon], { icon: sciIcon }).addTo(map);

    openSidebar();
    analyzeLocation(lat, lon);
});

document.querySelectorAll('.layer-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        document.querySelectorAll('.layer-btn').forEach(b => b.classList.remove('active'));
        const target = e.currentTarget;
        target.classList.add('active');

        const newLayerId = target.getAttribute('data-layer');
        if (currentLayerId !== newLayerId) {
            map.removeLayer(overlays[currentLayerId]);
            overlays[newLayerId].addTo(map);
            currentLayerId = newLayerId;

            if (currentMarker) {
                const latlng = currentMarker.getLatLng();
                analyzeLocation(latlng.lat, latlng.lng);
            }
        }
    });
});

async function analyzeLocation(lat, lon) {
    document.getElementById('coords').innerText = `${lat.toFixed(4)}° с.ш., ${lon.toFixed(4)}° в.д.`;

    document.getElementById('norm-container').classList.add('hidden');
    document.getElementById('factor-value').classList.add('hidden');
    document.getElementById('factor-unit').classList.add('hidden');
    document.getElementById('ai-text').classList.add('hidden');

    document.getElementById('value-loading').classList.remove('hidden');
    document.getElementById('ai-loading').classList.remove('hidden');

    btnComplex.classList.remove('hidden');
    complexBlock.classList.add('hidden');
    resetSingleAdvancedUI();
    resetComplexAdvancedUI();

    const ready = await ensureBackendReady();
    if (!ready) {
        document.getElementById('location-name').innerText = 'Сервер недоступен';
        document.getElementById('value-loading').classList.add('hidden');
        document.getElementById('factor-value').classList.remove('hidden');
        document.getElementById('factor-value').innerText = '—';
        document.getElementById('factor-unit').innerText = '';

        document.getElementById('ai-loading').classList.add('hidden');
        const aiTextEl = document.getElementById('ai-text');
        aiTextEl.innerText = 'Не удалось дождаться ответа backend. Попробуйте повторить через несколько секунд.';
        aiTextEl.classList.remove('hidden');
        return;
    }

    try {
        const data = await apiGet('/api/analyze-single', {
            lat,
            lon,
            map_type: currentLayerId
        });

        if (data.error) {
            document.getElementById('location-name').innerText = 'Вне зоны покрытия';
            document.getElementById('value-loading').classList.add('hidden');
            document.getElementById('factor-value').classList.remove('hidden');
            document.getElementById('factor-value').innerText = '—';
            document.getElementById('ai-loading').classList.add('hidden');
            document.getElementById('ai-text').innerText = data.error;
            document.getElementById('ai-text').classList.remove('hidden');
            return;
        }

        llmAvailable = Boolean(data.llm_available);

        document.getElementById('location-name').innerText = data.location_name;
        document.getElementById('factor-name').innerText = data.factor;

        document.getElementById('factor-norm').innerText = data.norm;
        document.getElementById('norm-container').classList.remove('hidden');

        document.getElementById('value-loading').classList.add('hidden');
        document.getElementById('factor-value').classList.remove('hidden');
        document.getElementById('factor-unit').classList.remove('hidden');
        document.getElementById('factor-value').innerText = data.value;
        document.getElementById('factor-unit').innerText = data.unit;

        document.getElementById('ai-loading').classList.add('hidden');
        const aiTextEl = document.getElementById('ai-text');
        aiTextEl.innerText = data.analysis;
        aiTextEl.classList.remove('hidden');

        if (llmAvailable) {
            btnSingleAdvanced.classList.remove('hidden');
        }
    } catch (error) {
        console.error(error);
        document.getElementById('value-loading').classList.add('hidden');
        document.getElementById('factor-value').classList.remove('hidden');
        document.getElementById('factor-value').innerText = '—';
        document.getElementById('ai-loading').classList.add('hidden');
        document.getElementById('ai-text').innerText = 'Сбой подключения к серверу пространственного анализа.';
        document.getElementById('ai-text').classList.remove('hidden');
    }
}

btnSingleAdvanced.addEventListener('click', async () => {
    if (!currentCoords || !llmAvailable) return;

    aiAdvancedTextEl.classList.add('hidden');
    aiAdvancedLoadingEl.classList.remove('hidden');

    try {
        const data = await apiGet('/api/analyze-single-advanced', {
            lat: currentCoords.lat,
            lon: currentCoords.lon,
            map_type: currentLayerId
        });

        aiAdvancedLoadingEl.classList.add('hidden');
        aiAdvancedTextEl.innerText = data.analysis || data.advanced_error || 'Расширенная интерпретация временно недоступна.';
        aiAdvancedTextEl.classList.remove('hidden');
    } catch (error) {
        console.error(error);
        aiAdvancedLoadingEl.classList.add('hidden');
        aiAdvancedTextEl.innerText = 'Ошибка получения расширенной интерпретации.';
        aiAdvancedTextEl.classList.remove('hidden');
    }
});

btnComplex.addEventListener('click', async () => {
    if (!currentCoords) return;

    btnComplex.classList.add('hidden');
    complexBlock.classList.remove('hidden');

    complexTextEl.classList.add('hidden');
    complexLoadingEl.classList.remove('hidden');
    resetComplexAdvancedUI();

    if (window.innerWidth <= 768) {
        sidebar.classList.replace('half-open', 'full-open');
    }

    try {
        const data = await apiGet('/api/analyze-complex', {
            lat: currentCoords.lat,
            lon: currentCoords.lon
        });

        complexLoadingEl.classList.add('hidden');
        complexTextEl.innerText = data.conclusion || data.error || 'Ошибка комплексной оценки.';
        complexTextEl.classList.remove('hidden');

        if (data.llm_available) {
            complexAdvancedWrap.classList.remove('hidden');
        }
    } catch (error) {
        console.error(error);
        complexLoadingEl.classList.add('hidden');
        complexTextEl.innerText = 'Ошибка генерации комплексной оценки.';
        complexTextEl.classList.remove('hidden');
    }
});

btnComplexAdvanced.addEventListener('click', async () => {
    if (!currentCoords || !llmAvailable) return;

    complexAdvancedTextEl.classList.add('hidden');
    complexAdvancedLoadingEl.classList.remove('hidden');

    try {
        const data = await apiGet('/api/analyze-complex-advanced', {
            lat: currentCoords.lat,
            lon: currentCoords.lon
        });

        complexAdvancedLoadingEl.classList.add('hidden');
        complexAdvancedTextEl.innerText = data.conclusion || data.advanced_error || 'Расширенная интерпретация временно недоступна.';
        complexAdvancedTextEl.classList.remove('hidden');
    } catch (error) {
        console.error(error);
        complexAdvancedLoadingEl.classList.add('hidden');
        complexAdvancedTextEl.innerText = 'Ошибка получения расширенной интерпретации.';
        complexAdvancedTextEl.classList.remove('hidden');
    }
});

(async () => {
    const ready = await checkBackendHealth({ timeoutMs: 7000, silent: false });
    if (!ready) {
        ensureBackendReady(65000);
    }
})();
