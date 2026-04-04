/**
 * --- ГОРOДСКОЙ ЭКСПОСОМ: АКУСТИЧЕСКАЯ МОДЕЛЬ ---
 * Скрипт-модель для генерации карты акустического шума (дБА).
 * Источники: WorldPop (население), VIIRS (трафик), ESA (лес/застройка), SRTM (рельеф).
 */

// 1. Полигон Крыма (GeoJSON -> Geometry)
// ВАЖНО: Ниже сокращенный список координат. 
// Полный GeoJSON копировать из Тез.txt
var crimeaGeoJSON = { "type": "Feature", "geometry": { "type": "Polygon", "coordinates": [[[34.9775505065918, 45.762852670319745], [35.04443359375, 45.6700439453125], [36.638336181640625, 45.35125732421875], [36.408843994140625, 45.14947509765625], [34.475250244140625, 44.723602294921875], [33.37109375, 44.58843994140625], [32.48583984375, 45.3948974609375], [33.62039566040039, 46.136311222062865], [34.408836364746094, 46.00578560402203], [34.9775505065918, 45.762852670319745]]] } };

// 2. Инициализация региона
var roi = ee.Feature(crimeaGeoJSON).geometry();

// === ПОДГОТОВКА ПЕРЕМЕННЫХ ===

// А) Плотность населения (WorldPop 100m) -> кол-во чел. на км2
var pop_den = ee.ImageCollection("WorldPop/GP/100m/pop")
    .filterDate('2020-01-01', '2020-12-31')
    .filterBounds(roi)
    .first()
    .unmask(0)
    .multiply(100);

// Б) Прокси-трафика (Ночные огни VIIRS)
var traffic_proxy = ee.ImageCollection('NOAA/VIIRS/DNB/MONTHLY_V1/VCMSLCFG')
    .filterDate('2023-01-01', '2023-12-31')
    .median()
    .select('avg_rad')
    .unmask(0);

// В) Рельеф (Препятствие для звука — Topography)
var elevation = ee.Image("USGS/SRTMGL1_003").unmask(0);
var slope = ee.Terrain.slope(elevation).clip(roi);

// Г) Покрытие земли (Леса — поглотители, Застройка — источники)
var land_cover = ee.Image("ESA/WorldCover/v200/2021").select('Map');
var built_up = land_cover.eq(50); // Здания, дороги
var forest = land_cover.eq(10);   // Лесные массивы

// === МОДЕЛИРОВАНИЕ ШУМА ===

var base_silence = ee.Image(35); // 35 дБА — фоновая тишина в поле

// 1. Вклад населения (10 * log10(pop + 1))
var source_pop = pop_den.add(1).log10().multiply(10);
// 2. Вклад транспорта/промышленности (15 * log10(lights + 1))
var source_transport = traffic_proxy.add(1).log10().multiply(15);
// 3. Дополнительный шум в застройке (+15 дБА)
var source_infra = built_up.multiply(15);

// Смешиваем первичные источники
var raw_noise = base_silence.add(source_pop).add(source_transport).add(source_infra);

// Имитируем расхождение волны (сглаживание на 800м)
var spread_noise = raw_noise.clip(roi).focal_mean({ radius: 800, units: 'meters' });

// Коэффициенты поглощения
var damp_slope = slope.multiply(0.3); // Уклон мешает звуку (0.3 дБА на градус)
var damp_forest = forest.multiply(6); // Лес "съедает" 6 дБА

// Итоговый акустический расчет
var final_noise = spread_noise.subtract(damp_slope).subtract(damp_forest).max(30).rename('Noise_dBA');

// === ВИЗУАЛИЗАЦИЯ И ЭКСПОРТ ===

var noise_vis = {
    min: 35,
    max: 75, // Пороги ВОЗ (от комфорта до опасного уровня)
    palette: ['#1a9850', '#91cf60', '#d9ef8b', '#fee08b', '#fc8d59', '#d73027', '#67001f']
};

Map.centerObject(roi, 8);
Map.addLayer(final_noise, noise_vis, 'Acoustic Noise Model (dBA)', true, 0.7);

// Выгружаем TIFF для интерактивной карты сайта
Export.image.toDrive({
    image: final_noise,
    description: 'Crimea_Acoustic_Model_Export',
    folder: 'GEE_AL_Analytic',
    fileNamePrefix: 'crimea_noise_model_v1',
    scale: 250,
    region: roi,
    maxPixels: 1e13
});
