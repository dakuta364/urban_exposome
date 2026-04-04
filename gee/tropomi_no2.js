/**
 * --- ГОРOДСКОЙ ЭКСПОСОМ: ЗАГРЯЗНЕНИЕ NO2 ---
 * Скрипт для работы с данными TROPOMI (Sentinel-5P).
 * Анализируем содержание диоксида азота в тропосфере (слой NO2).
 */

// 1. Полигон Крыма (GeoJSON -> Geometry)
// ВАЖНО: Ниже сокращенный список координат. 
// Полный GeoJSON можно копировать из Тез.txt
var crimeaGeoJSON = { "type": "Feature", "geometry": { "type": "Polygon", "coordinates": [[[34.9775505065918, 45.762852670319745], [35.04443359375, 45.6700439453125], [36.638336181640625, 45.35125732421875], [36.408843994140625, 45.14947509765625], [34.475250244140625, 44.723602294921875], [33.37109375, 44.58843994140625], [32.48583984375, 45.3948974609375], [33.62039566040039, 46.136311222062865], [34.408836364746094, 46.00578560402203], [34.9775505065918, 45.762852670319745]]] } };

// 2. Инициализация региона
var roi = ee.Feature(crimeaGeoJSON).geometry();

// 3. Данные Sentinel-5P TROPOMI NO2
// Используем OFFLINE версию — она точнее, чем Near-Real-Time (NRTI)
var dataset = ee.ImageCollection('COPERNICUS/S5P/OFFL/L3_NO2')
    .filterDate('2023-01-01', '2023-12-31') // Анализируем среднее годовое
    .filterBounds(roi);

/**
 * Функция конвертации из моль/м2 в микромоль/м2
 */
function convertToMicromoles(image) {
    // Нас интересует плотность в тропосфере — именно здесь люди дышат NO2
    var no2_trop = image.select('tropospheric_NO2_column_number_density');
    // Умножаем на 1млн для получения удобного целого числа (микромоли)
    var no2_micro = no2_trop.multiply(1000000).rename('no2_micro_mol');
    return image.addBands(no2_micro);
}

// 4. Обработка данных и сглаживание
var processedNO2 = dataset.map(convertToMicromoles).select('no2_micro_mol').median().clip(roi);

// Так как у TROPOMI довольно большие пиксели, размываем их радиусом 5км
// для плавного тематического слоя на карте
var smoothNO2 = processedNO2.focal_mean({ radius: 5000, units: 'meters' });

// 5. Визуализация NO2 (чисто — зеленое, смог — фиолетовый)
var visualNO2 = {
    min: 0,
    max: 40, // 40 микромолей — порог заметного загрязнения
    palette: ['green', 'yellow', 'orange', 'red', 'purple']
};

Map.centerObject(roi, 8);
Map.setOptions('HYBRID'); // Оставляем города для привязки
Map.addLayer(smoothNO2, visualNO2, 'Smoothed NO2 Air Pollution', true, 0.6);

// 6. Экспорт файла в Google Drive
Export.image.toDrive({
    image: smoothNO2,
    description: 'Crimea_NO2_Pollution_Export',
    folder: 'GEE_AL_Analytic',
    fileNamePrefix: 'crimea_no2_smooth_250m',
    scale: 250,
    region: roi,
    maxPixels: 1e13
});
