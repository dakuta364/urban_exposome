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

let currentLayerId = 'light';
overlays[currentLayerId].addTo(map);

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

const sidebar = document.getElementById('sidebar');
const closeBtn = document.getElementById('close-btn');
let currentMarker = null;
let currentCoords = null;

const sciIcon = L.divIcon({
    className: 'sci-marker',
    html: '<div class="sci-pulse"></div><div class="sci-dot"></div>',
    iconSize: [20, 20],
    iconAnchor: [10, 10]
});

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

closeBtn.addEventListener('click', closeSidebar);

let startY = 0;
sidebar.addEventListener('touchstart', e => { startY = e.touches[0].clientY; });
sidebar.addEventListener('touchend', e => {
    if (window.innerWidth > 768) return;
    let endY = e.changedTouches[0].clientY;

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

async function analyzeLocation(lat, lon) {
    document.getElementById('coords').innerText = `${lat.toFixed(4)}° с.ш., ${lon.toFixed(4)}° в.д.`;

    document.getElementById('norm-container').classList.add('hidden');
    document.getElementById('factor-value').classList.add('hidden');
    document.getElementById('factor-unit').classList.add('hidden');
    document.getElementById('ai-text').classList.add('hidden');

    document.getElementById('value-loading').classList.remove('hidden');
    document.getElementById('ai-loading').classList.remove('hidden');

    document.getElementById('btn-complex').classList.remove('hidden');
    document.getElementById('complex-result-block').classList.add('hidden');

    try {
        const response = await fetch(`http://127.0.0.1:8000/api/analyze-single?lat=${lat}&lon=${lon}&map_type=${currentLayerId}`);
        const data = await response.json();

        if (data.error) {
            document.getElementById('location-name').innerText = "Вне зоны покрытия";
            document.getElementById('value-loading').classList.add('hidden');
            document.getElementById('factor-value').classList.remove('hidden');
            document.getElementById('factor-value').innerText = "—";
            document.getElementById('ai-loading').classList.add('hidden');
            return;
        }

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

document.getElementById('btn-complex').addEventListener('click', async () => {
    if (!currentCoords) return;

    document.getElementById('btn-complex').classList.add('hidden');
    const complexBlock = document.getElementById('complex-result-block');
    complexBlock.classList.remove('hidden');

    document.getElementById('complex-text').classList.add('hidden');
    document.getElementById('complex-loading').classList.remove('hidden');

    if (window.innerWidth <= 768) {
        sidebar.classList.replace('half-open', 'full-open');
    }

    try {
        const response = await fetch(`http://127.0.0.1:8000/api/analyze-complex?lat=${currentCoords.lat}&lon=${currentCoords.lon}`);
        const data = await response.json();

        document.getElementById('complex-loading').classList.add('hidden');
        const complexTextEl = document.getElementById('complex-text');
        complexTextEl.innerText = data.conclusion;
        complexTextEl.classList.remove('hidden');

    } catch (error) {
        console.error(error);
        document.getElementById('complex-loading').classList.add('hidden');
        document.getElementById('complex-text').innerText = 'Ошибка генерации комплексной оценки.';
        document.getElementById('complex-text').classList.remove('hidden');
    }
});