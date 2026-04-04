/**
 * --- ГОРOДСКОЙ ЭКСПОСОМ: СВЕТОВОЕ ЗАГРЯЗНЕНИЕ ---
 * Скрипт для работы с данными VIIRS (VCM-SL-CFG).
 * Оцениваем ночное освещение, убираем шумы через сглаживание.
 */

// 1. Полигон Крыма (GeoJSON -> Geometry)
// ВАЖНО: Ниже сокращенный список координат. 
// Полный GeoJSON доступен в файле Тез.txt
var crimeaGeoJSON = { "type": "Feature", "geometry": { "type": "Polygon", "coordinates": [[[34.9775505065918, 45.762852670319745], [35.04443359375, 45.6700439453125], [36.638336181640625, 45.35125732421875], [36.408843994140625, 45.14947509765625], [34.475250244140625, 44.723602294921875], [33.37109375, 44.58843994140625], [32.48583984375, 45.3948974609375], [33.62039566040039, 46.136311222062865], [34.408836364746094, 46.00578560402203], [34.9775505065918, 45.762852670319745]]] } };

// 2. Инициализация региона
var roi = ee.Feature(crimeaGeoJSON).geometry();

// 3. Загружаем ежемесячную коллекцию VIIRS DNB
// Используем весь 2023 год для получения стабильного среднего сигнала
var lightsDataset = ee.ImageCollection('NOAA/VIIRS/DNB/MONTHLY_V1/VCMSLCFG')
    .filterDate('2023-01-01', '2023-12-31')
    .filterBounds(roi);

// 4. Очистка и расчет медианы (avg_rad канал)
var rawSignal = lightsDataset.select('avg_rad').median().clip(roi);

/**
 * Важный этап: Сглаживание.
 * Ночное освещение от спутника часто выглядит угловато ("квадраты"),
 * размываем его в радиусе 500м для визуальной эстетики на сайте.
 */
var smoothLights = rawSignal.focal_mean({ radius: 500, units: 'meters' });

// 5. Оформление (цветовая палитра: от темного к белому)
var lightVis = {
    min: 0,
    max: 60,
    palette: ['black', 'darkblue', 'purple', 'red', 'yellow', 'white']
};

Map.centerObject(roi, 8);
Map.setOptions('SATELLITE'); // Темная подложка лучше подчеркивает свет
Map.addLayer(smoothLights, lightVis, 'Smoothed Light Pollution', true, 0.7);
Map.addLayer(rawSignal, lightVis, 'Raw Lights (original blocks)', false, 0.7);

// 6. Сохранение GeoTIFF в Google Drive
Export.image.toDrive({
    image: smoothLights,
    description: 'Crimea_Nightlights_2023_Export',
    folder: 'GEE_AL_Analytic',
    fileNamePrefix: 'crimea_light_smooth_250m',
    scale: 250, // Шаг для сайта аналитики
    region: roi,
    maxPixels: 1e13
});
